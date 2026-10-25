<script setup lang="ts">
import { defineModel, defineProps, ref } from 'vue'

const props = defineProps<{
  min: number
  max: number
  // the side of the handle the resized panel is on
  side: 'left' | 'right'
}>()

// width of the panel in px
const width = defineModel<number>({ required: true })

const dragging = ref(false)
let startX = 0
let startWidth = 0

function clamp(value: number) {
  return Math.min(Math.max(value, props.min), props.max)
}

// measure from where the drag started so the pointer and the edge stay in sync after hitting a limit
function onPointerDown(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragging.value = true
  startX = e.clientX
  startWidth = width.value
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const dx = e.clientX - startX
  width.value = clamp(startWidth + (props.side === 'left' ? dx : -dx))
}

function onPointerUp() {
  dragging.value = false
}

// arrow keys resize too, shift for bigger steps
function onKeydown(e: KeyboardEvent) {
  const step = e.shiftKey ? 50 : 10
  const grow = props.side === 'left' ? 'ArrowRight' : 'ArrowLeft'
  const shrink = props.side === 'left' ? 'ArrowLeft' : 'ArrowRight'
  if (e.key === grow) width.value = clamp(width.value + step)
  else if (e.key === shrink) width.value = clamp(width.value - step)
  else return
  e.preventDefault()
}
</script>

<template>
  <div
    class="resize-handle"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-valuenow="Math.round(width)"
    :aria-valuemin="min"
    :aria-valuemax="Math.round(max)"
    @pointerdown.prevent="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  >
    <span class="grip"></span>
  </div>
</template>

<style scoped>
.resize-handle {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  touch-action: none;
}

/* thin divider along the full height, the grip sits on top of it */
.resize-handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background-color: var(--color-border);
}

.grip {
  position: relative;
  width: 4px;
  height: 40px;
  border-radius: 2px;
  background-color: var(--color-border-hover);
  transition:
    background-color 0.2s,
    height 0.2s;
}

.resize-handle:hover .grip,
.resize-handle.dragging .grip {
  height: 64px;
  background-color: var(--color-text-muted);
}

.resize-handle:focus-visible {
  outline: 2px solid var(--color-button);
  outline-offset: -2px;
}
</style>
