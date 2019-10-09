const main = {
  MINING_REWARD: 0,
  HTTP_PORT: 3001,
  BLOCKCHAIN_DATABASE: 'blockchain',
  UTXO_DATABASE: 'utxo',
  NATS_CLUSTER_ID: 'temtum',
  BLOCKS_PER_PAGE: 10,
  TX_PER_PAGE: 10,
  TX_OUTPUT_LIMIT: 1000,
  TX_MAX_VALIDITY_TIME: 259200000,
  REDIS_TX_CACHE: 'transactionCache',
  REDIS_BLOCK_CACHE: 'blockCache',
  REDIS_BLOCK_QUEUE: 'block_queue',
  BCRYPT_SALT_ROUNDS: 10,
  RESTORE_DB_FILE: '.bs',
  RESTORE_DB_TIMEOUT: 60000,
  BACKUP_DB_TIMEOUT: 3600000
};

export default main;
