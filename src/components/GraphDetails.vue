<script setup lang="ts">
import { computed, defineEmits, defineModel, defineProps } from 'vue'
import MarkdownEditor from './MarkdownEditor.vue'
import IndependenceSlider from './IndependenceSlider.vue'
import {
  childIds,
  parentIds,
  reachableIds,
  type GraphData,
  type IndependenceLevel,
} from '@/types/graph'

const props = defineProps<{
  data: GraphData
}>()

// id of the node clicked in the graph; clicking a neighbour here selects it instead
const selected = defineModel<string | null>('selected', { default: null })

const node = computed(() => props.data.nodes.find((n) => n.id === selected.value))

const emit = defineEmits<{
  setIndependence: [id: string, level: IndependenceLevel]
  addLink: [source: string, target: string]
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
const parents = computed(() => (selected.value ? parentIds(props.data, selected.value) : []))
const children = computed(() => (selected.value ? childIds(props.data, selected.value) : []))

// nodes that can be linked without duplicating a link or creating a cycle
function linkCandidates(direction: 'up' | 'down', existing: string[]): string[] {
  const id = selected.value
  if (!id) return []
  // a new parent must not already be below this node, and a new child not above it
  const blocked = reachableIds(props.data, id, direction === 'up' ? 'down' : 'up')
  return props.data.nodes
    .map((n) => n.id)
    .filter((other) => other !== id && !existing.includes(other) && !blocked.has(other))
}

const parentCandidates = computed(() => linkCandidates('up', parents.value))
const childCandidates = computed(() => linkCandidates('down', children.value))

// the select is reset to its placeholder after each pick
function addParent(event: Event) {
  const select = event.target as HTMLSelectElement
  if (selected.value && select.value) emit('addLink', select.value, selected.value)
  select.value = ''
}

function addChild(event: Event) {
  const select = event.target as HTMLSelectElement
  if (selected.value && select.value) emit('addLink', selected.value, select.value)
  select.value = ''
}
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
          <IndependenceSlider v-model="independence" :disabled="children.length > 0" />
          <span v-if="children.length" class="empty">
            Average of {{ children.length }} {{ children.length === 1 ? 'child' : 'children' }}
          </span>
        </dd>

        <dt>Parents ({{ parents.length }})</dt>
        <dd>
          <ul v-if="parents.length">
            <li v-for="id in parents" :key="id">
              <a href="#" @click.prevent="selected = id">{{ id }}</a>
            </li>
          </ul>
          <span v-else class="empty">None</span>
          <select v-if="parentCandidates.length" class="add-link" @change="addParent">
            <option value="">Add parent…</option>
            <option v-for="id in parentCandidates" :key="id" :value="id">{{ id }}</option>
          </select>
        </dd>

        <dt>Children ({{ children.length }})</dt>
        <dd>
          <ul v-if="children.length">
            <li v-for="id in children" :key="id">
              <a href="#" @click.prevent="selected = id">{{ id }}</a>
            </li>
          </ul>
          <span v-else class="empty">None</span>
          <select v-if="childCandidates.length" class="add-link" @change="addChild">
            <option value="">Add child…</option>
            <option v-for="id in childCandidates" :key="id" :value="id">{{ id }}</option>
          </select>
        </dd>
      </dl>

      <section>
        <h4>
          AI Summary
          <span v-if="node.summary" class="badge">Generated</span>
        </h4>
        <p v-if="node.summary" class="ai-summary">{{ node.summary }}</p>
        <p v-else class="empty">No summary generated yet.</p>
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

.add-link {
  display: block;
  margin-top: 0.25rem;
  max-width: 100%;
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
