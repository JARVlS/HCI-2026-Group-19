import type { GraphData as ForceGraphData, LinkObject, NodeObject } from 'force-graph'

// 0 (not independent) to 100 (fully independent)
export type IndependenceLevel = number
// summary is the AI-generated overview shown in the details panel, absent until one is generated
export type GraphNode = NodeObject & {
  id: string
  independence: IndependenceLevel
  summary?: string
}
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

// force-graph replaces link source/target ids with the node objects once it has run
export function endpointId(end: GraphLink['source']): string {
  return typeof end === 'object' ? (end as GraphNode).id : String(end)
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}

export function parentIds(data: GraphData, id: string): string[] {
  return unique(
    data.links.filter((l) => endpointId(l.target) === id).map((l) => endpointId(l.source)),
  )
}

export function childIds(data: GraphData, id: string): string[] {
  return unique(
    data.links.filter((l) => endpointId(l.source) === id).map((l) => endpointId(l.target)),
  )
}

// all ancestors ('up') or descendants ('down') of a node, without the node itself
export function reachableIds(data: GraphData, id: string, direction: 'up' | 'down'): Set<string> {
  const next = direction === 'up' ? parentIds : childIds
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length) {
    for (const other of next(data, stack.pop()!)) {
      if (seen.has(other) || other === id) continue
      seen.add(other)
      stack.push(other)
    }
  }
  return seen
}

// sets every node that has children to the rounded average of its children, bottom-up;
// edits the node objects in place because force-graph holds the same objects
export function updateAverages(data: GraphData) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const done = new Set<string>()
  const visiting = new Set<string>()

  function visit(node: GraphNode): IndependenceLevel {
    if (done.has(node.id) || visiting.has(node.id)) return node.independence
    visiting.add(node.id)
    const children = childIds(data, node.id)
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => n !== undefined)
    if (children.length) {
      const sum = children.reduce((total, child) => total + visit(child), 0)
      node.independence = Math.round(sum / children.length)
    }
    visiting.delete(node.id)
    done.add(node.id)
    return node.independence
  }

  data.nodes.forEach(visit)
}
