// Génère le tableau de bord Grafana : les requêtes restent lisibles et versionnées ici.
import { writeFileSync } from 'node:fs';

const ds = { type: 'prometheus', uid: 'prometheus' };
const panel = (id, title, x, y, w, h, targets, { type = 'timeseries', unit = 'short', extra = {} } = {}) => ({
  id, title, type, datasource: ds,
  gridPos: { x, y, w, h },
  fieldConfig: { defaults: { unit, custom: type === 'timeseries' ? { fillOpacity: 12, lineWidth: 2, showPoints: 'never' } : {} }, overrides: [] },
  options: type === 'stat'
    ? { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value', graphMode: 'area' }
    : { legend: { displayMode: 'table', placement: 'bottom', calcs: ['lastNotNull', 'max'] }, tooltip: { mode: 'multi' } },
  targets: targets.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), expr, legendFormat, datasource: ds })),
  ...extra,
});
const hq = (q) => `histogram_quantile(${q}, sum(rate(bn_event_latency_seconds_bucket[30s])) by (le))`;

const panels = [
  panel(1, 'Connexions actives', 0, 0, 6, 5, [['sum(bn_ws_connections_active)', 'total']], { type: 'stat' }),
  panel(2, 'Messages / s', 6, 0, 6, 5, [['sum(rate(bn_ws_messages_total[30s]))', 'total']], { type: 'stat', unit: 'reqps' }),
  panel(3, 'Latence p95', 12, 0, 6, 5, [[hq(0.95), 'p95']], { type: 'stat', unit: 's' }),
  panel(4, 'Erreurs / s', 18, 0, 6, 5, [['sum(rate(bn_errors_total[30s])) or vector(0)', 'erreurs']], { type: 'stat', unit: 'reqps' }),
  panel(5, 'Connexions par instance', 0, 5, 12, 8, [['bn_ws_connections_active', '{{instance_id}}']]),
  panel(6, 'Messages par sens et instance', 12, 5, 12, 8, [['sum by (instance_id, direction) (rate(bn_ws_messages_total[30s]))', '{{instance_id}} {{direction}}']], { unit: 'reqps' }),
  panel(7, 'Latence commande → socket destinataire', 0, 13, 12, 8, [[hq(0.5), 'p50'], [hq(0.95), 'p95'], [hq(0.99), 'p99']], { unit: 's' }),
  panel(8, 'Histogramme de latence', 12, 13, 12, 8, [['sum(rate(bn_event_latency_seconds_bucket[30s])) by (le)', '{{le}}']], {
    type: 'heatmap', extra: { options: { calculate: false, yAxis: { unit: 's' }, color: { scheme: 'Oranges' } } },
  }),
  panel(9, 'Erreurs par code', 0, 21, 8, 7, [['sum by (code) (rate(bn_errors_total[30s]))', '{{code}}']], { unit: 'reqps' }),
  panel(10, 'Déconnexions par cause', 8, 21, 8, 7, [['sum by (reason) (rate(bn_ws_disconnects_total[30s]))', '{{reason}}']], { unit: 'reqps' }),
  panel(11, 'Connexions refusées', 16, 21, 8, 7, [['sum by (reason) (rate(bn_ws_rejected_upgrades_total[30s]))', '{{reason}}']], { unit: 'reqps' }),
  panel(12, 'Boucle d\'événements (p99)', 0, 28, 8, 7, [['bn_node_nodejs_eventloop_lag_p99_seconds', '{{instance_id}}']], { unit: 's' }),
  panel(13, 'CPU par instance', 8, 28, 8, 7, [['rate(bn_node_process_cpu_seconds_total[30s])', '{{instance_id}}']], { unit: 'percentunit' }),
  panel(14, 'Doublons, conflits, rejeux', 16, 28, 8, 7, [
    ['sum(rate(bn_commands_duplicate_total[30s]))', 'commandes en double'],
    ['sum(rate(bn_store_cas_conflicts_total[30s]))', 'conflits CAS'],
    ['sum(rate(bn_events_replayed_total[30s]))', 'événements rejoués'],
  ], { unit: 'reqps' }),
];

const dashboard = {
  uid: 'bataille-navale', title: 'Bataille navale — temps réel', tags: ['websocket'], schemaVersion: 39, version: 1,
  refresh: '5s', time: { from: 'now-15m', to: 'now' }, timezone: 'browser', panels,
};
writeFileSync(new URL('../infra/grafana/dashboards/bataille-navale.json', import.meta.url), `${JSON.stringify(dashboard, null, 2)}\n`);
