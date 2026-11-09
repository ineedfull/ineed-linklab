<script setup>
import { computed, ref } from 'vue';
import { ListFilter, Search } from 'lucide-vue-next';

import EndpointRow from './EndpointRow.vue';

const props = defineProps({
  endpoints: { type: Array, required: true },
  activeEndpointId: { type: String, default: null },
  activePeerId: { type: String, default: null },
  statuses: { type: Map, required: true },
  operations: { type: Map, required: true },
  reconnects: { type: Map, required: true },
  peers: { type: Map, required: true },
  counters: { type: Map, required: true },
  collapsed: Boolean,
  loading: Boolean,
  error: { type: String, default: '' },
  filter: { type: String, default: 'all' },
});
const emit = defineEmits(['select-endpoint', 'select-peer', 'filter', 'edit', 'open', 'cancel', 'close', 'delete']);
const search = ref('');
const filterOptions = Object.freeze([
  ['all', '全部协议'],
  ['serial', '串口'],
  ['tcp', 'TCP'],
  ['websocket', 'WebSocket'],
  ['udp', 'UDP'],
  ['modbus', 'Modbus'],
  ['dlt645', 'DL/T 645'],
  ['opcua', 'OPC UA'],
  ['stomp', 'STOMP'],
]);

const groups = computed(() => [
  ['串口', 'serial'],
  ['TCP', 'tcp'],
  ['WebSocket', 'websocket'],
  ['UDP', 'udp'],
  ['Modbus', 'modbus'],
  ['电表 DL/T 645', 'dlt645'],
  ['OPC UA', 'opcua'],
  ['STOMP', 'stomp'],
].map(([label, transport]) => ({
  label,
  transport,
  endpoints: props.endpoints.filter((endpoint) => (
    (transport === endpoint.transport || endpoint.transport.startsWith(`${transport}-`))
    && endpoint.name.toLowerCase().includes(search.value.trim().toLowerCase())
  )),
})).filter(({ endpoints }) => endpoints.length > 0));

function endpointInitials(endpoint) {
  return endpoint.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}
</script>

<template>
  <nav
    class="endpoint-tree"
    aria-label="端点列表"
  >
    <template v-if="!collapsed">
      <label class="endpoint-tree__filter-select">
        <ListFilter
          :size="14"
          aria-hidden="true"
        />
        <select
          name="endpoint-filter"
          aria-label="协议分类"
          :value="filter"
          @change="emit('filter', $event.target.value)"
        >
          <option
            v-for="[value, label] in filterOptions"
            :key="value"
            :value="value"
          >{{ label }}</option>
        </select>
      </label>
      <label class="compact-search">
        <Search
          :size="14"
          aria-hidden="true"
        />
        <input
          v-model="search"
          type="search"
          aria-label="搜索端点"
          placeholder="搜索端点"
        >
      </label>
    </template>

    <div
      v-if="loading"
      class="endpoint-tree__state"
    >
      正在加载...
    </div>
    <div
      v-else-if="error"
      class="endpoint-tree__state endpoint-tree__state--error"
      :title="error"
    >
      {{ collapsed ? '!' : '无法加载端点' }}
    </div>
    <div
      v-else-if="groups.length === 0"
      class="endpoint-tree__state"
    >
      {{ collapsed ? '0' : endpoints.length === 0 && filter === 'all' ? '暂无端点' : '没有匹配的端点' }}
    </div>

    <div
      v-for="group in groups"
      v-else
      :key="group.transport"
      class="endpoint-tree__group"
    >
      <h2 v-if="!collapsed">
        {{ group.label }}
      </h2>
      <div
        v-for="endpoint in group.endpoints"
        :key="endpoint.id"
        class="endpoint-tree__entry"
      >
        <button
          v-if="collapsed"
          class="endpoint-initials"
          :class="{ active: activeEndpointId === endpoint.id }"
          type="button"
          :title="endpoint.name"
          :aria-label="endpoint.name"
          @click="emit('select-endpoint', endpoint.id)"
        >
          {{ endpointInitials(endpoint) }}
        </button>
        <EndpointRow
          v-else
          :endpoint="endpoint"
          :selected="activeEndpointId === endpoint.id"
          :status-event="statuses.get(endpoint.id)"
          :operation="operations.get(endpoint.id)"
          :reconnect-state="reconnects.get(endpoint.id)"
          :counter="counters.get(endpoint.id)"
          @select="emit('select-endpoint', endpoint.id)"
          @edit="emit('edit', endpoint)"
          @open="emit('open', endpoint.id)"
          @cancel="emit('cancel', endpoint.id)"
          @close="emit('close', endpoint.id)"
          @delete="emit('delete', endpoint.id)"
        />
        <ul
          v-if="!collapsed && ['tcp-server', 'websocket-server', 'udp-server'].includes(endpoint.transport) && peers.get(endpoint.id)?.length"
          class="endpoint-tree__peers"
          :aria-label="`${endpoint.transport === 'udp-server' ? 'UDP' : endpoint.transport === 'websocket-server' ? 'WebSocket' : 'TCP'} 服务端连接`"
        >
          <li
            v-for="peer in peers.get(endpoint.id)"
            :key="peer.id"
          >
            <button
              type="button"
              :class="{ active: activePeerId === peer.id }"
              :title="peer.remoteAddress ?? peer.id"
              @click="emit('select-endpoint', endpoint.id); emit('select-peer', peer.id)"
            >
              <span class="status-dot status-dot--online" />
              <span>{{ peer.remoteAddress ?? peer.id }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </nav>
</template>
