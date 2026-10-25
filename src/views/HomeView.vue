<script setup lang="ts">
import Introduction from '../components/Introduction.vue'
import Graph from '../components/Graph.vue'
import AddGraphNodes from '../components/AddGraphNodes.vue'
import GraphDetails from '../components/GraphDetails.vue'
import ResizeHandle from '../components/ResizeHandle.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { GraphData, GraphLink, GraphNode, IndependenceLevel } from '@/types/graph'

const name = ref(localStorage.getItem('Name') || '')

const graph_data: Ref<GraphData> = ref({
  nodes: [
    { id: 'Human Computer Interaction', independence: 90 },
    { id: 'Semester 5', independence: 50 },
    { id: 'Visual Computing', independence: 60 },
    { id: 'Introduction To Neuroinformatics', independence: 20 },
  ],
  links: [
    { source: 'Semester 5', target: 'Human Computer Interaction' },
    { source: 'Semester 5', target: 'Visual Computing' },
    { source: 'Semester 5', target: 'Introduction To Neuroinformatics' },
    { source: 'Semester 5', target: 'Visual Computing' },
  ],
})

// id of the node clicked in the graph, shared with the add form (as the parent) and the details panel
const selected_node = ref<string | null>(null)

// edits the node object in place: force-graph holds the same objects and links point at them,
// so replacing the node would detach it from the graph
function setIndependence(id: string, level: IndependenceLevel) {
  const node = graph_data.value.nodes.find((n) => n.id === id)
  if (node) node.independence = level
}

// markdown notes per node id, edited in the details panel
const node_notes = ref<Record<string, string>>({})

watch(name, (newName) => {
  localStorage.setItem('Name', newName)
})

// side panel sizing, all in px
const HANDLE_WIDTH = 8
const PANEL_MIN = 220
const PANEL_MAX_RATIO = 0.4
const GRAPH_MIN = 320

const viewportWidth = ref(window.innerWidth)

function storedWidth(key: string): number {
  const width = Number(localStorage.getItem(key))
  return width > 0 ? width : window.innerWidth / 4
}

const leftWidth = ref(storedWidth('leftPanelWidth'))
const rightWidth = ref(storedWidth('rightPanelWidth'))

// a panel may take up to 40% of the screen, but always leaves room for the graph
function panelMax(otherWidth: number): number {
  const roomLeft = viewportWidth.value - otherWidth - GRAPH_MIN - 2 * HANDLE_WIDTH
  return Math.max(PANEL_MIN, Math.min(viewportWidth.value * PANEL_MAX_RATIO, roomLeft))
}

const leftMax = computed(() => panelMax(rightWidth.value))
const rightMax = computed(() => panelMax(leftWidth.value))

// keep stored widths valid when the window shrinks
watch(
  [leftMax, rightMax],
  () => {
    leftWidth.value = Math.min(Math.max(leftWidth.value, PANEL_MIN), leftMax.value)
    rightWidth.value = Math.min(Math.max(rightWidth.value, PANEL_MIN), rightMax.value)
  },
  { immediate: true },
)

watch([leftWidth, rightWidth], ([left, right]) => {
  localStorage.setItem('leftPanelWidth', String(left))
  localStorage.setItem('rightPanelWidth', String(right))
})

const gridColumns = computed(
  () =>
    `${leftWidth.value}px ${HANDLE_WIDTH}px minmax(0, 1fr) ${HANDLE_WIDTH}px ${rightWidth.value}px`,
)

function onWindowResize() {
  viewportWidth.value = window.innerWidth
}

onMounted(() => window.addEventListener('resize', onWindowResize))
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize))
</script>

<template>
  <Introduction v-if="name == ''" v-model="name" />
  <main v-else :style="{ gridTemplateColumns: gridColumns }">
    <header>
      <h1>Welcome to Graph Control {{ name }}</h1>
    </header>
    <AddGraphNodes v-model:data="graph_data" v-model:selected="selected_node" />
    <ResizeHandle
      v-model="leftWidth"
      side="left"
      :min="PANEL_MIN"
      :max="leftMax"
      aria-label="Resize add nodes panel"
    />
    <Graph :data="graph_data" v-model:selected="selected_node" />
    <ResizeHandle
      v-model="rightWidth"
      side="right"
      :min="PANEL_MIN"
      :max="rightMax"
      aria-label="Resize node details panel"
    />
    <GraphDetails
      :data="graph_data"
      v-model:selected="selected_node"
      v-model:notes="node_notes"
      @set-independence="setIndependence"
    />
  </main>
</template>

<style scoped>
main {
  height: 100vh;
  width: 100vw;
  display: grid;
  grid-template-areas:
    'header header header header header'
    'add-graph-nodes resize-left graph resize-right node-details';
  grid-template-rows: 80px 1fr;
  /* columns are set inline from the panel widths */
}
/* let panels shrink below their content width */
main > * {
  min-width: 0;
}
header {
  grid-area: header;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-background-soft);
}
</style>
