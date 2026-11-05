<script setup lang="ts">
import { computed, defineEmits, defineModel, defineProps, ref } from 'vue'
import IndependenceSlider from './IndependenceSlider.vue'
import type { GraphData, GraphNode, IndependenceLevel } from '@/types/graph'

const props = defineProps<{
  data: GraphData
}>()

// node clicked in the graph; when set it is used as the parent
const selected = defineModel<string | null>('selected', { default: null })

// the parent owns the graph data, so new nodes are handed up instead of written here
const emit = defineEmits<{
  addNode: [node: GraphNode, parent: string | null]
}>()

const name = ref('')
const independence = ref<IndependenceLevel>(50)
// '' means nothing chosen yet, null means the new node is a root
const dropdownParent = ref<string | null>('')

const parentId = computed(() => selected.value ?? dropdownParent.value)

const trimmedName = computed(() => name.value.trim())
const nameTaken = computed(() => props.data.nodes.some((n) => n.id === trimmedName.value))
const canAdd = computed(() => trimmedName.value !== '' && !nameTaken.value && parentId.value !== '')

function addNode() {
  if (!canAdd.value) return
  emit('addNode', { id: trimmedName.value, independence: independence.value }, parentId.value)
  name.value = ''
}
</script>

<template>
  <div class="add-graph-nodes">
    <h2>Add Graph Nodes</h2>

    <form @submit.prevent="addNode">
      <label>
        Name
        <input v-model="name" placeholder="Node name" />
      </label>
      <p v-if="nameTaken" class="error">A node with this name already exists.</p>

      <label v-if="selected">
        Parent
        <span class="selected-parent">
          {{ selected }}
          <button type="button" @click="selected = null">Change</button>
        </span>
      </label>
      <label v-else>
        Parent
        <select v-model="dropdownParent">
          <option disabled value="">Select a parent node</option>
          <option :value="null">None (root node)</option>
          <option v-for="node in data.nodes" :key="node.id" :value="node.id">{{ node.id }}</option>
        </select>
      </label>

      <IndependenceSlider v-model="independence">Independence Level</IndependenceSlider>

      <button type="submit" :disabled="!canAdd">Add node</button>
    </form>
  </div>
</template>

<style scoped>
.add-graph-nodes {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 1rem;
}

form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: center;
  justify-content: flex-start;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.selected-parent {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.error {
  color: #e05d5d;
}
</style>
