import * as fs from 'fs';
import * as path from 'path';

import Block from '../blockchain/block';
import Config from '../config/main';
import Constant from '../constant';
import DB from '../platform/db';
import Redis from '../platform/redis';
import Helpers from '../util/helpers';
import logger from '../util/logger';

class BlockSave {
  public static buildUnspentKey(address, output) {
    const params = [Constant.UNSPENT_PREFIX + address];

    params.push(output.txOutId);
    params.push(output.txOutIndex);

    return Buffer.from(params.join('/'));
  }

  public static populateUnspentInputs(txOutId, outputs, unspentInputs) {
    for (let i = 0, length = outputs.length; i < length; i++) {
      const output = outputs[i];

      if (
        !output.address ||
        isNaN(output.amount) ||
        !Number.isInteger(output.amount) ||
        output.amount < 1
      ) {
        continue;
      }

      const key = output.address + txOutId;

      unspentInputs[key] = {
        txOutId,
        txOutIndex: i,
        amount: output.amount,
        address: output.address
      };
    }
  }

  private blockchainDB;
  private utxoDB;
  private redis: Redis;
  private natsServerState: 0 | 1 = 0;

  public constructor() {
    this.initDBs();
    this.redis = new Redis();
  }

  public initDBs() {
    const options = {
      noMetaSync: true,
      noSync: true
    };

    this.blockchainDB = new DB(Config.BLOCKCHAIN_DATABASE, options);
    this.utxoDB = new DB(Config.UTXO_DATABASE, options);
  }

  public async init(): Promise<void> {
    await this.redis.init();
    process.on('message', this.messageHandler.bind(this));

    process.on('SIGTERM', this.removeLockFile);
    process.on('SIGINT', this.removeLockFile);

    process.send({ type: 'worker_init' });
  }

  public async messageHandler(msg) {
    switch (msg.type) {
      case 'add':
        const { block } = msg;

        try {
          await this.saveBlock(block);
          process.send({ type: 'saved' });

          setImmediate(async () => {
            await this.redis.executeCommands();
          });
        } catch (err) {
          process.send({ type: 'error' });
        }
        break;
    }
  }

  public async populateTransactions(block, preparedData) {
    const unspentInputs = {};
    const spentInputs = {};
    const blockchainTxn = this.blockchainDB.initTxn();
    const length = block.data.length;
    let totalMoneyTransferredInBlock = 0;

    for (let i = 0; i < length; i++) {
      const tx = block.data[i];
      const txKey = Buffer.concat([
        Buffer.from(Constant.TRANSACTION_PREFIX),
        Buffer.from(tx.id, 'hex')
      ]);
      const info = {
        height: block.index,
        index: i
      };

      preparedData.blockData.push([
        this.blockchainDB.DBI,
        txKey,
        Buffer.from(JSON.stringify(info))
      ]);

      if (tx.type === 'regular' || block.index === 0) {
        if (length - i <= Config.TX_PER_PAGE) {
          this.redis.pushCommandByKey(
            JSON.stringify(tx),
            Config.REDIS_TX_CACHE
          );
        }

        totalMoneyTransferredInBlock += tx.txOuts[0].amount;

        BlockSave.populateUnspentInputs(tx.id, tx.txOuts, unspentInputs);
        this.populateSpentInputs(tx.txIns, spentInputs, preparedData);
      }
    }

    if (length > 1) {
      for (const item in unspentInputs) {
        if (!spentInputs[item]) {
          const address = Helpers.toShortAddress(unspentInputs[item].address);
          const unspentKey = BlockSave.buildUnspentKey(
            address,
            unspentInputs[item]
          );
          const unspentData = Buffer.from(JSON.stringify(unspentInputs[item]));

          preparedData.utxoData.push([
            this.utxoDB.DBI,
            unspentKey,
            unspentData
          ]);
        }
      }

      const stat = this._getStatistic(blockchainTxn);
      const statKey = Buffer.from(Constant.BLOCKCHAIN_STAT);

      stat.totalMoneyTransferred += totalMoneyTransferredInBlock;
      stat.totalTxs += block.index ? length - 1 : length;

      preparedData.blockData.push([
        this.blockchainDB.DBI,
        statKey,
        Buffer.from(JSON.stringify(stat))
      ]);

      this.redis.pushTrimCommand(Config.REDIS_TX_CACHE, Config.TX_PER_PAGE - 1);
    }

    blockchainTxn.abort();
  }

  public populateSpentInputs(inputs, spentInputs, preparedData) {
    for (let i = 0, length = inputs.length; i < length; i++) {
      const input = inputs[i];

      if (!input.address || isNaN(input.amount)) {
        continue;
      }

      const key = input.address + input.txOutId;

      spentInputs[key] = 1;

      const utxo = {
        txOutId: input.txOutId,
        txOutIndex: input.txOutIndex,
        amount: input.amount,
        address: input.address
      };
      const address = Helpers.toShortAddress(utxo.address);
      const unspentKey = BlockSave.buildUnspentKey(address, utxo);

      preparedData.utxoData.push([this.utxoDB.DBI, unspentKey]);
    }
  }

  public _getStatistic(txn) {
    const key = Buffer.from(Constant.BLOCKCHAIN_STAT);
    const data = this.blockchainDB.get(txn, key);

    if (data !== null) {
      return Helpers.JSONToObject(data.toString());
    }

    return {
      totalMoneyTransferred: 0,
      totalTxs: 0
    };
  }

  public saveBlock(block): Promise<boolean> {
    const preparedData = {
      blockData: [],
      utxoData: []
    };

    return new Promise(async (resolve, reject) => {
      const blockKey = Buffer.concat([
        Buffer.from(Constant.BLOCK_PREFIX),
        Buffer.from(block.hash, 'hex'),
        Buffer.from(Constant.BLOCK_SUFFIX)
      ]);
      const blockIndexKey = Buffer.concat([
        Buffer.from(Constant.CHAIN_PREFIX),
        Helpers.writeVarInt(block.index)
      ]);
      const blockTxKey = Buffer.concat([
        Buffer.from(Constant.BLOCK_TX_PREFIX),
        Buffer.from(block.hash, 'hex')
      ]);
      const compressedTxs = Buffer.from(block.data, 'base64');

      block.data = await Helpers.decompressData(compressedTxs, 'array');

      const blockHeader: string = JSON.stringify(
        Block.createBlockHeader(block)
      );

      preparedData.blockData.push([
        this.blockchainDB.DBI,
        blockKey,
        Buffer.from(blockHeader)
      ]);
      preparedData.blockData.push([
        this.blockchainDB.DBI,
        blockTxKey,
        compressedTxs
      ]);
      preparedData.blockData.push([
        this.blockchainDB.DBI,
        blockIndexKey,
        Buffer.from(block.hash, 'hex')
      ]);

      await this.populateTransactions(block, preparedData);

      Promise.all([
        this._saveBlockData(preparedData.blockData),
        this._saveUtxoData(preparedData.utxoData)
      ])
        .then(() => {
          this.redis.pushCommandByKey(blockHeader, Config.REDIS_BLOCK_CACHE);
          this.redis.pushTrimCommand(
            Config.REDIS_BLOCK_CACHE,
            Config.BLOCKS_PER_PAGE - 1
          );

          if (process.env.NODE_ENV === 'dev') {
            logger.info(`Block info: ${blockHeader}`);
          }

          resolve(true);
        })
        .catch((error) => {
          if (process.env.NODE_ENV === 'dev') {
            logger.warn(`Block info: ${blockHeader}`);
          }

          reject(error);
        });
    });
  }

  public _saveBlockData(data) {
    return new Promise((resolve, reject) => {
      this.blockchainDB.batchWrite(
        data,
        {
          ignoreNotFound: true
        },
        (error) => {
          if (error) {
            return reject(error);
          }

          return resolve(true);
        }
      );
    });
  }

  public _saveUtxoData(data) {
    return new Promise((resolve, reject) => {
      this.utxoDB.batchWrite(
        data,
        {
          ignoreNotFound: true
        },
        (error) => {
          if (error) {
            return reject(error);
          }

          return resolve(true);
        }
      );
    });
  }

  public getTransactionIndex(tid: Buffer, txn) {
    const key: Buffer = Buffer.concat([
      Buffer.from(Constant.TRANSACTION_PREFIX),
      tid
    ]);

    return this.blockchainDB.get(txn, key);
  }

  private removeLockFile() {
    fs.unlinkSync(path.join(process.cwd(), 'src/workers/save.lock'));
    process.exit(0);
  }
}

const blockSave = new BlockSave();

blockSave.init().catch((error) => {
  logger.error(error);
});
