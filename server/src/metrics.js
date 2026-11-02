import client from 'prom-client';
import { config } from './config.js';

export const registry = new client.Registry();
registry.setDefaultLabels({ instance_id: config.instance });
client.collectDefaultMetrics({ register: registry, prefix: 'bn_node_' });

const opts = { registers: [registry] };

export const metrics = {
  connections: new client.Gauge({ ...opts, name: 'bn_ws_connections_active', help: 'Connexions WebSocket actives sur cette instance' }),
  messages: new client.Counter({ ...opts, name: 'bn_ws_messages_total', help: 'Messages WebSocket', labelNames: ['direction', 'type'] }),
  bytes: new client.Counter({ ...opts, name: 'bn_ws_bytes_total', help: 'Octets applicatifs WebSocket', labelNames: ['direction'] }),
  errors: new client.Counter({ ...opts, name: 'bn_errors_total', help: 'Erreurs par code', labelNames: ['code'] }),
  disconnects: new client.Counter({ ...opts, name: 'bn_ws_disconnects_total', help: 'Déconnexions par cause', labelNames: ['reason'] }),
  rejected: new client.Counter({ ...opts, name: 'bn_ws_rejected_upgrades_total', help: 'Connexions refusées à la poignée de main', labelNames: ['reason'] }),
  latency: new client.Histogram({
    ...opts,
    name: 'bn_event_latency_seconds',
    help: 'Réception de la commande sur une instance → écriture de l\'événement sur la socket du destinataire',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
  casConflicts: new client.Counter({ ...opts, name: 'bn_store_cas_conflicts_total', help: 'Conflits d\'écriture optimiste' }),
  duplicates: new client.Counter({ ...opts, name: 'bn_commands_duplicate_total', help: 'Commandes ignorées car déjà traitées' }),
  replayed: new client.Counter({ ...opts, name: 'bn_events_replayed_total', help: 'Événements rejoués à la reprise' }),
  games: new client.Counter({ ...opts, name: 'bn_games_total', help: 'Parties', labelNames: ['state'] }),
};
