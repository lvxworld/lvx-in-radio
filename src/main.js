import { loadConfig } from './config.js';
import { startRadio } from './start.js';

const radio = await startRadio(loadConfig());

const shutdown = async () => {
  await radio.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

console.log(`LVX Radio is on ${radio.address}`);
