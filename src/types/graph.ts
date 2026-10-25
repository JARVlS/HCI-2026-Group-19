import type { GraphData as ForceGraphData, LinkObject, NodeObject } from 'force-graph'

// 0 (not independent) to 100 (fully independent)
export type IndependenceLevel = number
export type GraphNode = NodeObject & { id: string; independence: IndependenceLevel }
export type GraphLink = LinkObject<GraphNode>
export type GraphData = ForceGraphData<GraphNode, GraphLink>

export const INDEPENDENCE_MIN = 0
export const INDEPENDENCE_MAX = 100
export const INDEPENDENCE_STEP = 10

// red at the minimum, yellow in the middle, green at the maximum
export function independenceColor(level: IndependenceLevel): string {
  const t = Math.min(Math.max(level, INDEPENDENCE_MIN), INDEPENDENCE_MAX) / INDEPENDENCE_MAX
  return `hsl(${t * 120}, 70%, 50%)`
}

// the same scale as a CSS gradient, used for the slider track
export const independenceGradient = `linear-gradient(to right, ${independenceColor(0)}, ${independenceColor(50)}, ${independenceColor(100)})`
