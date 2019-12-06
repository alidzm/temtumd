import * as redis from 'redis';

import Helpers from '../util/helpers';
import Config from '../config/main';

class RedisDB {
  private client: redis.RedisClient;
  private commands = [];

  public async init(): Promise<void> {
    if (!(process.env.REDIS_HOST && process.env.REDIS_PORT)) {
      throw new Error(
        'REDIS_HOST and/or REDIS_PORT are not provided to env variables.'
      );
    }

    this.client = redis.createClient({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT),
      retry_strategy: () => 10000
    });
  }

  public pushCommand(command) {
    this.commands.push(command);
  }

  public executeCommands() {
    return new Promise((resolve) => {
      if (!this.commands.length) {
        return resolve();
      }

      return this.client.multi(this.commands).exec((): void => {
        this.commands = [];

        resolve();
      });
    });
  }

  public setHashRedisData(key: string, hash: string, data: any): Promise<void> {
    return new Promise((resolve, reject): void => {
      this.client.hset(key, hash, JSON.stringify(data), (err): void => {
        if (err) {
          return reject(err);
        }

        return resolve();
      });
    });
  }

  public getHashRedisData(key: string, hash: string): any {
    return new Promise((resolve, reject): void => {
      this.client.hget(key, hash, (err, res): void => {
        if (err) {
          return reject(err);
        }

        return resolve(res && Helpers.JSONToObject(res));
      });
    });
  }

  public getAllHashRedisData(key: string): Promise<any[]> {
    return new Promise((resolve, reject): void => {
      this.client.hgetall(key, (err, res): void => {
        const data = [];

        if (err) {
          return reject(err);
        }

        for (let key in res) {
          const parsedData = Helpers.JSONToObject(res[key]);

          data.push(parsedData);
        }

        return resolve(data);
      });
    });
  }

  public deleteRedisDataByKey(key: string): Promise<void> {
    return new Promise((resolve, reject): void => {
      this.client.del(key, (err): void => {
        if (err) {
          return reject(err);
        }

        return resolve();
      });
    });
  }

  public getRedisList(key: string): Promise<any[]> {
    return new Promise((resolve, reject): void => {
      this.client.lrange(key, 0, -1, (err, res): void => {
        if (err) {
          return reject(err);
        }

        const data = res.map((block) => {
          return Helpers.JSONToObject(block);
        });

        return resolve(data || []);
      });
    });
  }

  public pushTrimCommand(key: string, end: number): void {
    this.pushCommand(['ltrim', key, '0', end]);
  }

  public pushCommandByKey(data: any, key: string, type = 'lpush'): void {
    this.pushCommand([type, key, data]);
  }

  public deleteField(key: string, field: string): Promise<void> {
    return new Promise((resolve, reject): void => {
      this.client.hdel(key, field, (err): void => {
        if (err) {
          return reject(err);
        }

        return resolve();
      });
    });
  }

  public incrFieldBy(key: string, field: string, increment = 1): Promise<void> {
    return new Promise((resolve, reject): void => {
      this.client.hincrby(key, field, increment, (err): void => {
        if (err) {
          return reject(err);
        }

        return resolve();
      });
    });
  }
}

export default RedisDB;
