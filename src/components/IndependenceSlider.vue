<script setup lang="ts">
import { defineModel, defineProps } from 'vue'
import {
  INDEPENDENCE_MAX,
  INDEPENDENCE_MIN,
  INDEPENDENCE_STEP,
  independenceColor,
  independenceGradient,
  type IndependenceLevel,
} from '@/types/graph'

const level = defineModel<IndependenceLevel>({ required: true })

// read-only when the level is computed elsewhere, e.g. averaged from child nodes
defineProps<{
  disabled?: boolean
}>()
</script>

<template>
  <label class="independence">
    <span class="independence-label">
      <!-- optional caption, shown left of the current value -->
      <slot />
      <span class="independence-value">
        <span
          class="independence-dot"
          :style="{ backgroundColor: independenceColor(level) }"
        ></span>
        {{ level }}%
      </span>
    </span>
    <input
      v-model.number="level"
      type="range"
      class="independence-slider"
      :min="INDEPENDENCE_MIN"
      :max="INDEPENDENCE_MAX"
      :step="INDEPENDENCE_STEP"
      :disabled="disabled"
      :style="{ background: independenceGradient, accentColor: independenceColor(level) }"
    />
  </label>
</template>

<style scoped>
.independence {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.independence-label {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.independence-value {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-variant-numeric: tabular-nums;
}

.independence-dot {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
}

.independence-slider {
  width: 100%;
  height: 0.5rem;
  border-radius: 999px;
  appearance: none;
  cursor: pointer;
}

.independence-slider:disabled {
  cursor: default;
  opacity: 0.6;
}

.independence-slider::-webkit-slider-thumb {
  appearance: none;
  width: 1rem;
  height: 1rem;
  border: 2px solid var(--color-background);
  border-radius: 50%;
  background: var(--color-text);
}

.independence-slider::-moz-range-thumb {
  width: 1rem;
  height: 1rem;
  border: 2px solid var(--color-background);
  border-radius: 50%;
  background: var(--color-text);
}
</style>
