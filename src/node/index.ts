import axios from 'axios';
import * as STAN from 'node-nats-streaming';
import { EventEmitter } from 'events';

import Blockchain from '../blockchain';
import Config from '../config/main';
import { StanConfig } from '../config/node';
import { StanOptions } from '../interfaces/stan';
import Queue from '../util/queue';
import Helpers from '../util/helpers';
import logger from '../util/logger';
import Backup from '../util/backup';

class Node {
  private synchronized: 0 | 1 = 0;
  private natsBlockStatus: 0 | 1 = 0;
  private httpSyncAttempts: number = 0;
  private natsBlockSubStatus: 0 | 1 = 0;
  private subscriptionPending: 0 | 1 = 0;
  private lastBackupTime;
  private backupProcessing: 0 | 1 = 0;
  private httpSyncInProgress: 0 | 1 = 0;

  public readonly blockchain: Blockchain;
  public readonly queue: Queue;
  public readonly emitter: EventEmitter;

  public natsBlock;
  public ready: 0 | 1 = 0;
  public blockSubscription: any;

  public constructor(emitter, blockchain, queue) {
    this.emitter = emitter;
    this.blockchain = blockchain;
    this.queue = queue;
    this.lastBackupTime = new Date().getTime();
  }

  public initEventHandlers() {
    this.queue.on(
      'queue_drained',
      async (): Promise<void> => {
        await this.resyncChain();
      }
    );

    this.queue.on(
      'queue_ready',
      async (): Promise<void> => {
        await this.resyncChain();
      }
    );

    this.emitter.on('block_processing_finished', (): void => {
      if (
        this.lastBackupTime + Config.BACKUP_DB_TIMEOUT <=
          new Date().getTime() &&
        !this.backupProcessing
      ) {
        this.backupProcessing = 1;

        Backup.backup()
          .catch((err) => {
            logger.error(err);
          })
          .finally(() => this.backupHandler());
      }
    });

    this.emitter.on('set_sync_status',
      async (data): Promise<void> => {
        this.setSyncStatus(data);
        await this.resyncChain();
      }
    );
  }

  private backupHandler(): void {
    this.lastBackupTime = new Date().getTime();
    this.backupProcessing = 0;
  }

  public setReadyStatus(status: 0 | 1): void {
    if (this.ready === status) {
      return;
    }
    this.ready = status;
  }

  protected connectToBlockServer(servers: string[]): Promise<boolean> {
    return new Promise((resolve, reject): void => {
      const clientID = process.env.HOST.replace(/\./g, '-');
      const opts: StanOptions = {
        servers,
        reconnect: StanConfig.RECONNECT,
        maxReconnectAttempts: StanConfig.MAX_RECONNECT_ATTEMPTS,
        waitOnFirstConnect: StanConfig.WAIT_ON_FIRST_CONNECT,
        reconnectTimeWait: StanConfig.RECONNECT_TIME_WAIT,
        stanPingInterval: StanConfig.STAN_PING_INTERVAL
      };

      if (process.env.NATS_USER && process.env.NATS_PASS) {
        opts.user = process.env.NATS_USER;
        opts.pass = process.env.NATS_PASS;
      }

      this.natsBlock = STAN.connect(StanConfig.NATS_CLUSTER_ID, clientID, opts);

      this.natsBlock.on('reconnecting', (): void => {
        logger.info('Main app attempting to reconnect to STAN.');
      });

      this.natsBlock.on(
        'reconnect',
        async (): Promise<void> => {
          logger.info('Main app reconnected to STAN.');
          this.setNatsBlockStatus(1);
          if (this.getSyncStatus()) {
            this.initBlockSubscription();
          }

          await this.resyncChain();
        }
      );

      this.natsBlock.on('disconnect', (): void => {
        logger.info('Main app disconnected from STAN.');
        this.setNatsBlockStatus(0);
        this.natsBlockUnsubscribeAndReset();
      });

      this.natsBlock.on(
        'connect',
        async (): Promise<void> => {
          logger.info('Main app connected to STAN.');
          this.setNatsBlockStatus(1);
          if (this.getSyncStatus()) {
            this.initBlockSubscription();

            return resolve(true);
          }

          await this.resyncChain();

          resolve(true);
        }
      );

      this.natsBlock.on('error', (error): void => {
        logger.error(error);
      });

      this.natsBlock.on('close', (): void => {
        if (this.getNatsBlockStatus()) {
          logger.info('Main app connection to STAN is closed.');

          this.setNatsBlockStatus(0);
          this.natsBlockUnsubscribeAndReset();
          this.setNatsSubscriptionPending(0);
        }

        if (this.natsBlock) {
          this.natsBlock.removeAllListeners();
          this.natsBlock = null;

          setTimeout(async (): Promise<void> => {
            try {
              await this.connectToBlockServer(servers);
            } catch (err) {}
          }, StanConfig.AUTO_RECONNECT_INTERVAL);

          reject(false);
        }
      });
    });
  }

  public async connectToMessageService(servers) {
    servers = servers.split(',').map((item) => {
      return item.trim();
    });
    try {
      await this.connectToBlockServer(servers);
    } catch (error) {}
  }

  public initBlockSubscription(): void {
    const errorHandler = (err): void => {
      this.setNatsSubscriptionPending(0);
      logger.error(err);
      this.natsBlock.close();
    };

    if (!this.getNatsBlockStatus() || this.getNatsBlockSubStatus()) {
      return;
    }

    if (this.getNatsSubscriptionPending()) {
      return;
    }

    this.setNatsSubscriptionPending(1);

    this.blockSubscription = this.natsBlock.subscribe('BLOCK_ADDED');

    this.blockSubscription.on('error', errorHandler);

    this.blockSubscription.on('timeout', errorHandler);

    this.blockSubscription.on(
      'ready',
      async (): Promise<void> => {
        this.setNatsSubscriptionPending(0);
        logger.info('Main app subscribed to STAN.');
        this.setNatsBlockSubStatus(1);
        await this.verifyFullReady();

        this.blockSubscription.on(
          'message',
          async (data): Promise<void> => {
            const msg = Helpers.JSONToObject(data.getData());

            try {
              await this.handleReceivedFromBroker(msg.data);
            } catch (error) {
              logger.error(error);
            }
          }
        );
      }
    );
  }

  public async init() {
    await this.connectToMessageService(process.env.NATS_SERVERS);
  }

  protected async httpSync(): Promise<void> {
    if (!process.env.SYNC_ADDRESS) {
      throw new Error('SYNC_ADDRESS variable is not exist.');
    }

    try {
      this.setHttpSyncInProgress(1);

      const lastBlockResponse = await axios.get(
        `${process.env.SYNC_ADDRESS}/block/last`
      );
      const lastPeerBlock = lastBlockResponse.data;

      if (lastPeerBlock) {
        let currentBlock = await this.blockchain.getLastBlock();

        switch (true) {
          case !currentBlock:
            await this.requestBlocks(-1);

            break;
          case (lastPeerBlock.index > currentBlock.index):
            await this.requestBlocks(currentBlock.index);

            break;
          case (
            lastPeerBlock.index === currentBlock.index &&
            lastPeerBlock.hash !== currentBlock.hash
          ):
            await this.blockchain.deleteBlockByIndex(currentBlock.index);
            await this.requestBlocks(currentBlock.index - 1);

            break;
          case (lastPeerBlock.index < currentBlock.index):
            const blockToCheck = await this.blockchain.getBlockByIndex(
              lastPeerBlock.index
            );

            if (!blockToCheck || lastPeerBlock.hash !== blockToCheck.hash) {
              while (currentBlock.index >= lastPeerBlock.index) {
                await this.blockchain.deleteBlockByIndex(currentBlock.index);
                currentBlock = await this.blockchain.getLastBlock();
              }

              await this.requestBlocks(currentBlock.index);
              break;
            }
          default:
            this.setSyncStatus(1);
            this.initBlockSubscription();
        }
      }

      this.httpSyncAttempts = 0;

      this.setHttpSyncInProgress(0);
    } catch (error) {
      logger.error(error);

      this.httpSyncAttempts++;
      this.setHttpSyncInProgress(0);
      await Helpers.wait(this.httpSyncAttempts * 3000);
      await this.httpSync();
    }
  }

  public async requestBlocks(start) {
    const syncResponse = await axios.post(`${process.env.SYNC_ADDRESS}/sync`, {
      start
    });

    await this.handleBlocks(syncResponse.data.blocks);
  }

  public run() {
    this.init().then(() => {
      this.initEventHandlers();
    });
  }

  public isNodeReady() {
    return this.ready;
  }

  public async handleBlocks(receivedBlocks): Promise<boolean> {
    if (!Array.isArray(receivedBlocks) || !receivedBlocks.length) {
      return true;
    }

    const currentBlock = await this.blockchain.getLastBlock();
    const startChainBlock = receivedBlocks[receivedBlocks.length - 1];

    if (!currentBlock) {
      await this.blockchain.updateChain(receivedBlocks);

      return true;
    }

    if (startChainBlock.index <= currentBlock.index) {
      logger.info(
        'Received chain is not longer than current chain. Do nothing.'
      );

      return true;
    }

    if (currentBlock.index + 1 === startChainBlock.index) {
      if (currentBlock.hash === startChainBlock.previousHash) {
        logger.info(
          `Blockchain possibly behind. We got: ${currentBlock.index}, Peer got: ${startChainBlock.index}`
        );

        await this.blockchain.updateChain(receivedBlocks);

        return true;
      }

      await this.blockchain.deleteBlockByIndex(currentBlock.index);
      await this.requestBlocks(currentBlock.index - 1);
    }

    this.setSyncStatus(1);
    this.initBlockSubscription();

    return false;
  }

  public async resyncChain(): Promise<void> {
    if (
      !this.getSyncStatus() &&
      !this.getHttpSyncInProgress() &&
      !await this.queue.count()
    ) {
      await this.httpSync();
    }
  }

  public getSyncStatus(): 0 | 1 {
    return this.synchronized;
  }

  private setNatsBlockStatus(state: 0 | 1): void {
    if (this.natsBlockStatus !== state) {
      this.natsBlockStatus = state;
    }
  }

  protected natsBlockUnsubscribeAndReset(): void {
    this.setSyncReadyStatus(0);
    this.natsBlockUnsubscribe();
  }

  public setSyncReadyStatus(status: 0 | 1): void {
    this.setSyncStatus(status);
    this.setReadyStatus(status);
  }

  public setSyncStatus(status: 0 | 1): void {
    if (this.synchronized !== status) {
      this.synchronized = status;
    }
  }

  protected natsBlockUnsubscribe(): void {
    if (this.getNatsBlockSubStatus()) {
      this.blockSubscription.unsubscribe();
      this.setNatsBlockSubStatus(0);

      logger.info('Main app unsubscribed from STAN.');
    }
  }

  protected setNatsBlockSubStatus(status: 0 | 1): void {
    if (this.natsBlockSubStatus !== status) {
      this.natsBlockSubStatus = status;
    }
  }

  public getNatsBlockSubStatus(): 0 | 1 {
    return this.natsBlockSubStatus;
  }

  private getNatsBlockStatus(): 0 | 1 {
    return this.natsBlockStatus;
  }

  public async handleReceivedFromBroker(receivedBlocks): Promise<void> {
    if (!Array.isArray(receivedBlocks) || receivedBlocks.length !== 1) {
      logger.warn('Received message from broker server has wrong format.');

      return;
    }

    await this.blockchain.addBlockToChain(receivedBlocks[0], true);
  }

  public async verifyFullReady(): Promise<void> {
    if (
      !(this.getSyncStatus() && this.getReadyStatus()) &&
      this.getNatsBlockStatus()
    ) {
      if (!this.getSyncStatus()) {
        await this.resyncChain();
        return;
      }

      this.setReadyStatus(1);
    }
  }

  public getReadyStatus(): 0 | 1 {
    return this.ready;
  }

  private getHttpSyncInProgress(): 0 | 1 {
    return this.httpSyncInProgress;
  }

  private setHttpSyncInProgress(status: 0 | 1): void {
    if (this.httpSyncInProgress !== status) {
      this.httpSyncInProgress = status;
    }
  }

  private setNatsSubscriptionPending(status: 0 | 1): void {
    if (this.subscriptionPending !== status) {
      this.subscriptionPending = status;
    }
  }

  private getNatsSubscriptionPending(): 0 | 1 {
    return this.subscriptionPending;
  }
}

export default Node;
