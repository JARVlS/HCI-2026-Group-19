<script setup lang="ts">
import { defineProps, ref } from 'vue'

const props = defineProps<{
  pretext: string
  confirm: (name: string) => void
}>()

const name = ref('')
function submit() {
  props.confirm(name.value)
}
</script>

<template>
  <h1>
    {{ props.pretext }}
    <input @keydown.enter="submit" placeholder="Your Name" class="entername" v-model="name" />
  </h1>
  <button @click="submit">Start Your Journey</button>
</template>

<style scoped>
h1 {
  font-weight: 500;
  font-size: 2.6rem;
  position: relative;
  top: -10px;
}

h3 {
  font-size: 1.2rem;
}
button {
  background-color: transparent;
  color: var(--color-text);
  border: 1px solid var(--color-button);
  box-shadow: 0 0 10px 0px var(--color-button);
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1.2rem;
  margin-top: 1rem;
}
.entername {
  text-decoration: dotted underline;
  border: none;
  background: transparent;
  font-size: 1em;
  color: var(--color-text-muted);
  outline: none;
  field-sizing: content;
}

@media (min-width: 1024px) {
  .entername h1,
  .entername h3 {
    text-align: left;
  }
}
</style>
