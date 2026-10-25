<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { ref, watchEffect } from 'vue'

const stored = localStorage.getItem('theme')
const dark = ref(
  stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches,
)

watchEffect(() => {
  const theme = dark.value ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  localStorage.setItem('theme', theme)
})
</script>

<template>
  <!-- <header>
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/about">About</RouterLink>
    </nav>
  </header> -->

  <label class="theme-toggle" title="Toggle light/dark mode">
    <input type="checkbox" v-model="dark" aria-label="Dark mode" />
    <span class="track"><span class="thumb"></span></span>
  </label>

  <RouterView />
</template>

<style scoped>
.theme-toggle {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 10;
  cursor: pointer;
}

.theme-toggle input {
  position: absolute;
  opacity: 0;
}

.track {
  display: block;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--color-background-mute);
  border: 1px solid var(--color-border-hover);
  transition: background-color 0.3s;
}

.thumb {
  display: block;
  width: 18px;
  height: 18px;
  margin: 2px;
  border-radius: 50%;
  background: var(--color-text);
  transition: transform 0.3s;
}

input:checked + .track .thumb {
  transform: translateX(20px);
}

input:focus-visible + .track {
  outline: 2px solid var(--color-button);
  outline-offset: 2px;
}
</style>
