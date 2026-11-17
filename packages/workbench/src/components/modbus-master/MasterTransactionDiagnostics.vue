<script setup>
import { formatTime, transactionIdentity } from '../../model/modbusMasterPresentation.js';
defineProps({
  presentation: { type: Object, required: true },
  diagnosticTransactions: { type: Array, required: true },
});
// Selection remains owned by the panel when switching tabs.
const selectedTransaction = defineModel('selectedTransaction', { type: Object, default: null });
</script>

<template>
  <section
    class="modbus-master-records"
  >
    <section
      v-if="selectedTransaction"
      class="modbus-diagnostic-detail"
      :class="presentation.isTcpTransaction(selectedTransaction) ? 'modbus-diagnostic-detail--tcp' : 'modbus-diagnostic-detail--rtu'"
      aria-label="Modbus 报文详情"
    >
      <header>
        <div>
          <span class="modbus-diagnostic-detail__protocol">{{ presentation.transactionProtocolTitle(selectedTransaction) }} · {{ presentation.transactionProtocolDescription(selectedTransaction) }}</span>
          <strong>{{ presentation.transactionCommand(selectedTransaction).functionLabel }}</strong>
          <span>{{ presentation.transactionGroupName(selectedTransaction) }} · {{ presentation.transactionRequestName(selectedTransaction) }} · {{ presentation.transactionCommand(selectedTransaction).requestText }}</span>
        </div>
        <div class="modbus-diagnostic-detail__status">
          <span
            class="quality"
            :class="selectedTransaction.success ? 'quality--good' : 'quality--bad'"
          >{{ selectedTransaction.success ? '成功' : '失败' }}</span>
          <time>{{ formatTime(selectedTransaction.createdAt) }}</time>
        </div>
      </header>

      <div class="modbus-diagnostic-frames">
        <section class="modbus-diagnostic-frame">
          <header><strong>{{ presentation.transactionFrameHeading(selectedTransaction, 'request') }}</strong><span>{{ presentation.transactionFrameType(selectedTransaction, 'request') }}</span></header>
          <code
            v-if="presentation.transactionRequestHex(selectedTransaction)"
            class="modbus-diagnostic-frame__hex"
          >{{ presentation.transactionRequestHex(selectedTransaction) }}</code>
          <p v-else>
            请求帧不可用
          </p>
          <div
            v-if="presentation.transactionCommand(selectedTransaction).requestSegments.length"
            class="modbus-diagnostic-segments"
          >
            <div
              v-for="segment in presentation.transactionCommand(selectedTransaction).requestSegments"
              :key="`request:${segment.key}`"
            >
              <span>{{ segment.label }}</span><code>{{ segment.hex }}</code>
            </div>
          </div>
        </section>
        <section
          class="modbus-diagnostic-frame"
          :class="{ failed: !selectedTransaction.success }"
        >
          <header><strong>{{ presentation.transactionFrameHeading(selectedTransaction, 'response') }}</strong><span>{{ presentation.transactionFrameType(selectedTransaction, 'response') }}</span></header>
          <code
            v-if="presentation.transactionResponseHex(selectedTransaction)"
            class="modbus-diagnostic-frame__hex"
          >{{ presentation.transactionResponseHex(selectedTransaction) }}</code>
          <p v-else>
            {{ selectedTransaction.success ? '响应帧不可用' : '未收到有效响应帧' }}
          </p>
          <div
            v-if="presentation.transactionCommand(selectedTransaction).responseSegments.length"
            class="modbus-diagnostic-segments"
          >
            <div
              v-for="segment in presentation.transactionCommand(selectedTransaction).responseSegments"
              :key="`response:${segment.key}`"
            >
              <span>{{ segment.label }}</span><code>{{ segment.hex }}</code>
            </div>
          </div>
        </section>
      </div>

      <dl class="modbus-diagnostic-metadata">
        <div><dt>请求组</dt><dd>{{ presentation.transactionGroupName(selectedTransaction) }}</dd></div>
        <div><dt>请求</dt><dd>{{ presentation.transactionRequestName(selectedTransaction) }}</dd></div>
        <div><dt>从站地址</dt><dd>{{ selectedTransaction.unitId }}</dd></div>
        <div><dt>地址 / 数量</dt><dd>{{ selectedTransaction.address }} / {{ selectedTransaction.quantity }}</dd></div>
        <div><dt>尝试次数</dt><dd>{{ presentation.transactionRecord(selectedTransaction)?.attempt ?? '—' }}</dd></div>
        <div><dt>响应耗时</dt><dd>{{ selectedTransaction.durationMs === null || selectedTransaction.durationMs === undefined ? '—' : `${selectedTransaction.durationMs} ms` }}</dd></div>
        <template v-if="presentation.isTcpTransaction(selectedTransaction)">
          <div><dt>事务 ID</dt><dd><code>{{ presentation.transactionSegmentHex(selectedTransaction, 'request', 'transaction-id') }}</code></dd></div>
          <div><dt>协议 ID</dt><dd><code>{{ presentation.transactionSegmentHex(selectedTransaction, 'request', 'protocol-id') }}</code></dd></div>
          <div><dt>请求长度</dt><dd><code>{{ presentation.transactionSegmentHex(selectedTransaction, 'request', 'length') }}</code></dd></div>
          <div><dt>响应长度</dt><dd><code>{{ presentation.transactionSegmentHex(selectedTransaction, 'response', 'length') }}</code></dd></div>
        </template>
        <template v-else>
          <div>
            <dt>请求 CRC16</dt><dd class="quality quality--good">
              <code>{{ presentation.transactionSegmentHex(selectedTransaction, 'request', 'crc16') }}</code>
            </dd>
          </div>
          <div>
            <dt>响应 CRC16</dt><dd :class="presentation.transactionResponseHex(selectedTransaction) ? 'quality quality--good' : ''">
              <code>{{ presentation.transactionSegmentHex(selectedTransaction, 'response', 'crc16') }}</code>
            </dd>
          </div>
        </template>
        <div class="modbus-diagnostic-metadata__message">
          <dt>诊断结果</dt><dd :class="{ failed: !selectedTransaction.success }">
            {{ selectedTransaction.success ? '通信成功，响应解析正常' : (selectedTransaction.message ?? 'Modbus 通信失败') }}
          </dd>
        </div>
      </dl>
    </section>
    <div
      v-else
      class="table-empty modbus-diagnostic-empty"
    >
      暂无 Modbus 报文
    </div>

    <div
      class="modbus-diagnostic-list"
      aria-label="Modbus 报文列表"
    >
      <button
        v-for="transaction in diagnosticTransactions"
        :key="transactionIdentity(transaction)"
        type="button"
        :class="{ active: selectedTransaction && transactionIdentity(selectedTransaction) === transactionIdentity(transaction), failed: !transaction.success }"
        @click="selectedTransaction = transaction"
      >
        <span class="modbus-diagnostic-list__result">{{ transaction.success ? '成功' : '失败' }}</span>
        <strong>{{ presentation.transactionCommand(transaction).functionLabel }}</strong>
        <span>{{ presentation.transactionGroupName(transaction) }} · {{ presentation.transactionRequestName(transaction) }} · {{ presentation.transactionCommand(transaction).requestText }}<template v-if="!transaction.success"> · {{ transaction.message ?? 'Modbus 通信失败' }}</template></span>
        <time>{{ formatTime(transaction.createdAt) }}</time>
        <div class="modbus-diagnostic-list__frames">
          <span>TX</span><code>{{ presentation.transactionRequestHex(transaction) || '—' }}</code>
          <span>RX</span><code>{{ presentation.transactionResponseHex(transaction) || '—' }}</code>
        </div>
      </button>
      <p
        v-if="diagnosticTransactions.length === 0"
        class="table-empty"
      >
        暂无收发指令
      </p>
    </div>
  </section>
</template>
