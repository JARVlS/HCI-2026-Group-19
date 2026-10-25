<script setup lang="ts">
import EditableText from './EditableText.vue'
import { defineModel, ref } from 'vue'

const name = defineModel<string>({ default: '' })

function confirm(conf_name: string) {
  name.value = conf_name
}
</script>

<template>
  <div class="introduction">
    <EditableText pretext="How can I call you?" :confirm="confirm" />
  </div>
</template>

<style scoped>
.introduction {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
</style>
