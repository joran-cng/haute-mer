import { config } from './config.js';

// Journaux JSON : l'instance figure sur chaque ligne (critère phase 4, instance visible).
const write = (level, msg, fields) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, instance: config.instance, msg, ...fields }));
};

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
