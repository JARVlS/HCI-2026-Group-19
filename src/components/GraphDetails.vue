<script setup lang="ts">
import { computed, defineEmits, defineModel, defineProps } from 'vue'
import MarkdownEditor from './MarkdownEditor.vue'
import IndependenceSlider from './IndependenceSlider.vue'
import type { GraphData, GraphLink, GraphNode, IndependenceLevel } from '@/types/graph'

const props = defineProps<{
  data: GraphData
}>()

// id of the node clicked in the graph; clicking a neighbour here selects it instead
const selected = defineModel<string | null>('selected', { default: null })

const node = computed(() => props.data.nodes.find((n) => n.id === selected.value))

const emit = defineEmits<{
  setIndependence: [id: string, level: IndependenceLevel]
}>()

// the parent owns the graph data, so slider changes are handed up instead of written here
const independence = computed({
  get: () => node.value?.independence ?? 0,
  set: (level: IndependenceLevel) => {
    if (node.value) emit('setIndependence', node.value.id, level)
  },
})

// markdown notes keyed by node id
const notes = defineModel<Record<string, string>>('notes', { default: () => ({}) })

const nodeNotes = computed({
  get: () => (selected.value ? (notes.value[selected.value] ?? '') : ''),
  set: (text: string) => {
    if (selected.value) notes.value = { ...notes.value, [selected.value]: text }
  },
})

// placeholder until a real summary is generated
const aiSummary =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.'

// force-graph replaces link source/target ids with the node objects once it has run
function endpointId(end: GraphLink['source']): string {
  return typeof end === 'object' ? (end as GraphNode).id : String(end)
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}

const parents = computed(() =>
  unique(
    props.data.links
      .filter((l) => endpointId(l.target) === selected.value)
      .map((l) => endpointId(l.source)),
  ),
)

const children = computed(() =>
  unique(
    props.data.links
      .filter((l) => endpointId(l.source) === selected.value)
      .map((l) => endpointId(l.target)),
  ),
)
</script>

<template>
  <div class="graph-details">
    <h2>Node Details</h2>

    <p v-if="!node" class="empty">Click a node in the graph to see its details.</p>

    <template v-else>
      <h3>{{ node.id }}</h3>

      <dl>
        <dt>Independence Level</dt>
        <dd>
          <IndependenceSlider v-model="independence" />
        </dd>

        <dt>Parents ({{ parents.length }})</dt>
        <dd>
          <ul v-if="parents.length">
            <li v-for="id in parents" :key="id">
              <a href="#" @click.prevent="selected = id">{{ id }}</a>
            </li>
          </ul>
          <span v-else class="empty">None</span>
        </dd>

        <dt>Children ({{ children.length }})</dt>
        <dd>
          <ul v-if="children.length">
            <li v-for="id in children" :key="id">
              <a href="#" @click.prevent="selected = id">{{ id }}</a>
            </li>
          </ul>
          <span v-else class="empty">None</span>
        </dd>
      </dl>

      <section>
        <h4>
          AI Summary
          <span class="badge">Generated</span>
        </h4>
        <p class="ai-summary">{{ aiSummary }}</p>
      </section>

      <section>
        <h4>Notes</h4>
        <MarkdownEditor
          :key="node.id"
          v-model="nodeNotes"
          placeholder="Click to add notes (Markdown supported)"
        />
      </section>

      <button type="button" @click="selected = null">Deselect</button>
    </template>
  </div>
</template>

<style scoped>
.graph-details {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
}

dl {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 1rem;
}

dt {
  margin-top: 0.5rem;
  color: var(--color-text-muted);
}

dd {
  margin: 0;
}

ul {
  padding-left: 1.25rem;
}

a {
  text-decoration: underline;
}

.empty {
  color: var(--color-text-muted);
}

section {
  width: 100%;
  margin-bottom: 1rem;
}

h4 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  color: var(--color-text-muted);
}

.badge {
  padding: 0 0.4rem;
  border: 1px solid var(--color-border-hover);
  border-radius: 999px;
  font-size: 0.75rem;
}

.ai-summary {
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--color-border-hover);
  background-color: var(--color-background-soft);
  font-size: 0.95rem;
}
</style>
