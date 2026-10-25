<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, defineProps, defineModel, toRaw, watch } from 'vue'
import ForceGraph from 'force-graph'
import { independenceColor, type GraphData, type GraphLink, type GraphNode } from '@/types/graph'

const props = defineProps<{
  data: GraphData
}>()

// id of the clicked node, null when the background is clicked
const selected = defineModel<string | null>('selected', { default: null })

const el = ref<HTMLDivElement | null>(null)
let graph: ForceGraph<GraphNode, GraphLink> | undefined

// low=bjects on purpose, see note below

function cssVar(cssvar: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssvar).trim()
}

let linkColor = cssVar('--link-color')

const nodeColor = (n: GraphNode) => independenceColor(n.independence)

function refreshTheme() {
  linkColor = cssVar('--link-color')
  // re-applying the accessor makes force-graph repaint with the new color
  graph?.linkColor(() => linkColor)
}

let observer: MutationObserver | undefined
let resizeObserver: ResizeObserver | undefined
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

onMounted(() => {
  const container = el.value
  if (!container) return

  graph = new ForceGraph<GraphNode, GraphLink>(container)
    .graphData(toRaw(props.data))
    .nodeLabel('id')
    .nodeColor(nodeColor)
    .onNodeClick((n) => (selected.value = (n as GraphNode).id))
    .onBackgroundClick(() => (selected.value = null))
    .linkColor(() => linkColor)

  // force-graph defaults to the window size, so keep the canvas matched to the container
  resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return
    const { width, height } = entry.contentRect
    graph?.width(width).height(height)
  })
  resizeObserver.observe(container)

  // force-graph mutates nodes every tick (x, y, vx, ...), so hand it the raw objects
  // instead of Vue proxies; a new data object is assigned whenever nodes are added
  watch(
    () => props.data,
    (data) => graph?.graphData(toRaw(data)),
  )

  // independence is edited in place, so watch the levels and repaint with the new colors
  watch(
    () => props.data.nodes.map((n) => n.independence),
    () => graph?.nodeColor(nodeColor),
  )

  // re-read theme colors when the manual toggle or the OS preference changes
  observer = new MutationObserver(refreshTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  mediaQuery.addEventListener('change', refreshTheme)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  mediaQuery.removeEventListener('change', refreshTheme)
  graph?._destructor()
})
</script>

<style scoped>
.graph {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
  overflow: hidden;
}

/* keep the canvas out of the flow so it never stretches its own container */
.graph-canvas {
  position: absolute;
  inset: 0;
}
</style>

<template>
  <div class="graph">
    <div class="graph-canvas" ref="el"></div>
  </div>
</template>
