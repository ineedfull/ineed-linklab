<script setup>
import { Activity, Cable, Clock3 } from 'lucide-vue-next';
defineProps({
  endpoint: { type: Object, required: true },
  config: { type: Object, required: true },
  running: Boolean,
  enabledGroupCount: { type: Number, required: true },
  connectionAddress: { type: String, required: true },
});
const PARITY_LABELS = Object.freeze({ none: '无校验', even: '偶校验', odd: '奇校验' });
</script>

<template>
  <section
    class="modbus-master-summary"
  >
    <header class="modbus-master-overview">
      <div class="modbus-master-overview__identity">
        <span
          class="modbus-master-overview__icon"
          aria-hidden="true"
        ><Activity :size="18" /></span>
        <div>
          <span>{{ endpoint.transport === 'modbus-tcp-master' ? 'Modbus TCP 主站' : 'Modbus RTU 主站' }}</span>
          <h2>{{ endpoint.name }}</h2>
          <p v-if="config.description">
            {{ config.description }}
          </p>
        </div>
      </div>
      <div class="modbus-master-overview__status">
        <span
          class="modbus-master-state"
          :class="{ 'modbus-master-state--active': running }"
        ><i />{{ running ? '已连接' : '未连接' }}</span>
        <span><strong>{{ enabledGroupCount }}</strong> / {{ config.requestGroups.length }} 请求组已启用</span>
      </div>
    </header>

    <div class="modbus-master-detail-grid">
      <section
        class="modbus-master-detail-section modbus-master-detail-section--connection"
        aria-labelledby="modbus-master-connection-title"
      >
        <header>
          <Cable
            :size="16"
            aria-hidden="true"
          />
          <div>
            <h3 id="modbus-master-connection-title">
              连接信息
            </h3><p>{{ connectionAddress }}</p>
          </div>
        </header>
        <dl class="modbus-master-detail-list">
          <div><dt>通信模式</dt><dd>{{ endpoint.transport === 'modbus-tcp-master' ? 'Modbus TCP' : 'Modbus RTU' }}</dd></div>
          <template v-if="endpoint.transport === 'modbus-tcp-master'">
            <div><dt>主机地址</dt><dd>{{ config.host }}</dd></div>
            <div><dt>端口</dt><dd>{{ config.port }}</dd></div>
          </template>
          <template v-else>
            <div><dt>串口</dt><dd>{{ config.path ?? '未设置' }}</dd></div>
            <div><dt>波特率</dt><dd>{{ config.baudRate ?? 9600 }} baud</dd></div>
            <div><dt>线路参数</dt><dd>{{ config.dataBits ?? 8 }} 数据位 · {{ config.stopBits ?? 1 }} 停止位 · {{ PARITY_LABELS[config.parity] ?? config.parity }}</dd></div>
          </template>
        </dl>
      </section>

      <section
        class="modbus-master-detail-section modbus-master-detail-section--strategy"
        aria-labelledby="modbus-master-strategy-title"
      >
        <header>
          <Clock3
            :size="16"
            aria-hidden="true"
          />
          <div>
            <h3 id="modbus-master-strategy-title">
              执行策略
            </h3><p>请求节奏与故障恢复</p>
          </div>
        </header>
        <dl class="modbus-master-detail-list">
          <div>
            <dt>主站状态</dt><dd>
              <span
                class="modbus-master-detail-state"
                :class="{ active: config.enabled }"
              ><i />{{ config.enabled ? '已启用' : '已停用' }}</span>
            </dd>
          </div>
          <div><dt>请求超时</dt><dd>{{ config.timeoutMs }} ms</dd></div>
          <div><dt>失败重试</dt><dd>{{ config.retryCount }} 次</dd></div>
          <div><dt>重试间隔</dt><dd>{{ config.retryIntervalMs }} ms</dd></div>
          <div>
            <dt>断线重连</dt><dd>
              <span
                class="modbus-master-detail-state"
                :class="{ active: config.autoReconnect }"
              ><i />{{ config.autoReconnect ? '已启用' : '未启用' }}</span>
            </dd>
          </div>
          <div><dt>最小请求间隔</dt><dd>{{ config.scheduler.minGapMs }} ms</dd></div>
          <div><dt>自动轮询</dt><dd>{{ config.scheduler.autoStart ? '连接后启动' : '手动启动' }}</dd></div>
        </dl>
      </section>
    </div>
  </section>
</template>
