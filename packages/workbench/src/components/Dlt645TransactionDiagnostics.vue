<script setup>
import { formatTimestamp as formatTime } from '../model/dateTime.js';
import { formatDlt645Hex } from '@ineed-linklab/codecs/dlt645.js';

defineProps({
  transactions: { type: Array, default: () => [] },
  selectedTransaction: { type: Object, default: null },
});

defineEmits(['select']);

function directionLabel(entry) {
  return entry?.direction === 'out' ? 'TX' : 'RX';
}

function transactionFrame(transaction, kind) {
  return kind === 'request' ? transaction.request : transaction.response;
}

function transactionAddress(transaction) {
  return transaction.request?.parsed.address ?? transaction.response?.parsed.address ?? '--';
}

function transactionIdentifier(transaction) {
  return transaction.request?.parsed.dataIdentifier
    ?? transaction.response?.parsed.dataIdentifier
    ?? '--';
}

function transactionStatus(transaction) {
  if (transaction.response?.parsed.abnormal) return '异常应答';
  if (transaction.error) return transaction.error;
  if (transaction.request && transaction.response) return '完成';
  if (transaction.request) return '等待响应';
  return '未匹配请求';
}

function transactionDuration(transaction) {
  if (!transaction.request || !transaction.response) return '--';
  return `${Math.max(0, transaction.response.createdAt - transaction.request.createdAt)} ms`;
}

function controlHex(entry) {
  return entry
    ? entry.parsed.control.toString(16).toUpperCase().padStart(2, '0')
    : '--';
}

function frameHex(entry) {
  return entry ? formatDlt645Hex(entry.parsed.bytes) : '';
}


</script>

<template>
  <section class="dlt645-transaction-diagnostics">
    <div
      v-if="selectedTransaction"
      class="dlt645-transaction-detail"
    >
      <header>
        <div>
          <strong>DL/T 645-2007 通信事务</strong>
          <span>电表 {{ transactionAddress(selectedTransaction) }} · DI {{ transactionIdentifier(selectedTransaction) }}</span>
        </div>
        <div>
          <span
            class="dlt645-transaction-status"
            :class="{ failed: selectedTransaction.response?.parsed.abnormal || selectedTransaction.error }"
          >{{ transactionStatus(selectedTransaction) }}</span>
          <time>{{ formatTime(selectedTransaction.createdAt) }}</time>
        </div>
      </header>

      <div class="dlt645-transaction-frames">
        <section
          v-for="kind in ['request', 'response']"
          :key="kind"
          class="dlt645-transaction-frame"
        >
          <header>
            <strong>{{ transactionFrame(selectedTransaction, kind) ? directionLabel(transactionFrame(selectedTransaction, kind)) : '--' }} {{ kind === 'request' ? '请求帧' : '响应帧' }}</strong>
            <span>{{ transactionFrame(selectedTransaction, kind) ? '校验通过' : (kind === 'request' ? '未匹配请求' : (selectedTransaction.error ? '响应失败' : '未收到响应')) }}</span>
          </header>
          <code
            v-if="transactionFrame(selectedTransaction, kind)"
            class="dlt645-transaction-frame__hex"
          >{{ frameHex(transactionFrame(selectedTransaction, kind)) }}</code>
          <p v-else>
            {{ kind === 'request' ? '请求帧不可用' : (selectedTransaction.error || '等待响应') }}
          </p>
          <div
            v-if="transactionFrame(selectedTransaction, kind)"
            class="dlt645-transaction-segments"
          >
            <div
              v-for="segment in transactionFrame(selectedTransaction, kind).parsed.segments"
              :key="segment.key"
            >
              <span>{{ segment.label }}</span><code>{{ segment.hex }}</code>
            </div>
          </div>
        </section>
      </div>

      <dl class="dlt645-transaction-metadata">
        <div><dt>电表地址</dt><dd>{{ transactionAddress(selectedTransaction) }}</dd></div>
        <div><dt>数据标识</dt><dd><code>{{ transactionIdentifier(selectedTransaction) }}</code></dd></div>
        <div><dt>请求控制码</dt><dd><code>{{ controlHex(selectedTransaction.request) }}</code></dd></div>
        <div><dt>响应控制码</dt><dd><code>{{ controlHex(selectedTransaction.response) }}</code></dd></div>
        <div><dt>往返耗时</dt><dd>{{ transactionDuration(selectedTransaction) }}</dd></div>
        <div>
          <dt>校验</dt><dd :class="selectedTransaction.request || selectedTransaction.response ? 'quality quality--good' : ''">
            {{ selectedTransaction.request || selectedTransaction.response ? '通过' : '--' }}
          </dd>
        </div>
        <div
          v-if="selectedTransaction.error"
          class="dlt645-transaction-metadata__message"
        >
          <dt>通信结果</dt><dd class="quality quality--bad">
            {{ selectedTransaction.error }}
          </dd>
        </div>
        <div
          v-if="selectedTransaction.response?.parsed.abnormal"
          class="dlt645-transaction-metadata__message"
        >
          <dt>异常应答</dt><dd class="quality quality--bad">
            {{ selectedTransaction.response.parsed.errorFlags.join('、') || '电表返回异常应答' }}
          </dd>
        </div>
      </dl>
    </div>
    <div
      v-else
      class="dlt645-transaction-empty"
    >
      暂无 DL/T 645 通信事务
    </div>

    <div
      class="dlt645-transaction-list"
      aria-label="DL/T 645 通信事务列表"
    >
      <button
        v-for="transaction in transactions"
        :key="transaction.id"
        type="button"
        :class="{ active: selectedTransaction?.id === transaction.id, failed: transaction.response?.parsed.abnormal || transaction.error }"
        @click="$emit('select', transaction)"
      >
        <span class="dlt645-transaction-list__status">{{ transactionStatus(transaction) }}</span>
        <strong>电表 {{ transactionAddress(transaction) }}</strong>
        <span>DI {{ transactionIdentifier(transaction) }}</span>
        <time>{{ formatTime(transaction.createdAt) }}</time>
        <div class="dlt645-transaction-list__frames">
          <span>{{ transaction.request ? directionLabel(transaction.request) : '--' }}</span><code>{{ transaction.request ? frameHex(transaction.request) : '请求帧不可用' }}</code>
          <span>{{ transaction.response ? directionLabel(transaction.response) : '--' }}</span><code>{{ transaction.response ? frameHex(transaction.response) : (transaction.error || '未收到响应') }}</code>
        </div>
      </button>
      <p
        v-if="transactions.length === 0"
        class="dlt645-transaction-empty"
      >
        暂无 DL/T 645 通信事务
      </p>
    </div>
  </section>
</template>

<style scoped>
.dlt645-transaction-diagnostics { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto minmax(120px, 1fr); overflow: hidden; background: var(--surface-muted); }
.dlt645-transaction-detail { min-width: 0; background: var(--surface); border: 1px solid var(--line); }
.dlt645-transaction-detail > header { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 16px; padding: 7px 11px; background: var(--surface-control); border-bottom: 1px solid var(--line-soft); }
.dlt645-transaction-detail > header > div { display: flex; min-width: 0; align-items: center; gap: 10px; }
.dlt645-transaction-detail > header > div:first-child { display: grid; flex: 1; gap: 2px; }
.dlt645-transaction-detail > header strong { font-size: var(--font-size-control); }
.dlt645-transaction-detail > header span, .dlt645-transaction-detail > header time { color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-transaction-status { color: var(--success) !important; font-weight: 600; }
.dlt645-transaction-status.failed { color: var(--danger) !important; }
.dlt645-transaction-frames { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dlt645-transaction-frame { min-width: 0; padding: 8px 11px; }
.dlt645-transaction-frame + .dlt645-transaction-frame { border-left: 1px solid var(--line-soft); }
.dlt645-transaction-frame > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.dlt645-transaction-frame > header strong { color: var(--accent); font-size: var(--font-size-small); }
.dlt645-transaction-frame > header span { color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-transaction-frame__hex, .dlt645-transaction-frame > p { display: block; min-height: 34px; margin: 0; padding: 8px 10px; overflow-wrap: anywhere; color: #d1fae5; background: #111827; font: var(--font-size-small)/1.55 ui-monospace, monospace; }
.dlt645-transaction-frame > p { color: #94a3b8; }
.dlt645-transaction-segments { display: flex; min-width: 0; flex-wrap: wrap; gap: 3px 14px; padding: 6px 9px; border: 1px solid var(--line-soft); border-top: 0; }
.dlt645-transaction-segments > div { display: inline-grid; grid-template-columns: auto auto; align-items: baseline; gap: 5px; }
.dlt645-transaction-segments span { color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-transaction-segments code { font-size: var(--font-size-small); }
.dlt645-transaction-metadata { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px 18px; margin: 0; padding: 0 11px 8px; }
.dlt645-transaction-metadata > div { display: inline-flex; min-width: 0; align-items: baseline; gap: 5px; }
.dlt645-transaction-metadata dt { flex: 0 0 auto; color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-transaction-metadata dd { min-width: 0; margin: 0; font-size: var(--font-size-small); }
.dlt645-transaction-metadata__message { flex: 1 1 240px; }
.dlt645-transaction-list { min-width: 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; background: var(--surface); border: 1px solid var(--line); border-top: 0; }
.dlt645-transaction-list > button { display: grid; width: 100%; min-width: 0; grid-template-columns: 70px minmax(130px, auto) minmax(150px, 1fr) 80px; align-items: baseline; gap: 3px 10px; padding: 7px 11px; color: var(--text); background: transparent; border: 0; border-bottom: 1px solid var(--line-soft); text-align: left; }
.dlt645-transaction-list > button:hover { background: var(--surface-control); }
.dlt645-transaction-list > button.active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.dlt645-transaction-list > button.failed .dlt645-transaction-list__status { color: var(--danger); }
.dlt645-transaction-list__status { color: var(--success); font-size: var(--font-size-small); font-weight: 600; }
.dlt645-transaction-list > button > strong { font-size: var(--font-size-small); }
.dlt645-transaction-list > button > span:not(.dlt645-transaction-list__status), .dlt645-transaction-list time { color: var(--text-muted); font-size: var(--font-size-small); }
.dlt645-transaction-list time { justify-self: end; }
.dlt645-transaction-list__frames { display: grid; min-width: 0; grid-column: 2 / -1; grid-template-columns: 20px minmax(0, 1fr); gap: 2px 7px; }
.dlt645-transaction-list__frames span { color: var(--text-muted); font-size: var(--font-size-small); font-weight: 700; }
.dlt645-transaction-list__frames code { min-width: 0; overflow: hidden; font-size: var(--font-size-small); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.dlt645-transaction-empty { display: grid; min-height: 120px; place-content: center; color: var(--text-muted); text-align: center; }
@media (max-width: 700px) {
  .dlt645-transaction-diagnostics { overflow-y: auto; }
  .dlt645-transaction-frames { grid-template-columns: 1fr; }
  .dlt645-transaction-frame + .dlt645-transaction-frame { border-top: 1px solid var(--line-soft); border-left: 0; }
  .dlt645-transaction-list { min-height: 220px; overflow: visible; }
  .dlt645-transaction-list > button { grid-template-columns: 70px minmax(0, 1fr); }
  .dlt645-transaction-list > button > span:not(.dlt645-transaction-list__status), .dlt645-transaction-list time { grid-column: 2; }
  .dlt645-transaction-list time { justify-self: start; }
  .dlt645-transaction-list__frames { grid-column: 1 / -1; }
}
</style>
