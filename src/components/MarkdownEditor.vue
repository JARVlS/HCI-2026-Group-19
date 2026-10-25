<script setup lang="ts">
import { computed, defineModel, defineProps, nextTick, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

defineProps<{
  placeholder?: string
}>()

const text = defineModel<string>({ default: '' })

const editing = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)

// sanitized because the result goes into v-html
const html = computed(() => DOMPurify.sanitize(marked.parse(text.value, { async: false })))

async function startEditing(e?: Event) {
  // let links in the rendered notes work instead of switching to the editor
  if (e && (e.target as HTMLElement).closest('a')) return
  editing.value = true
  await nextTick()
  textarea.value?.focus()
}
</script>

<template>
  <textarea
    v-if="editing"
    ref="textarea"
    v-model="text"
    class="markdown-source"
    :placeholder="placeholder"
    @blur="editing = false"
    @keydown.esc="textarea?.blur()"
  ></textarea>
  <div
    v-else
    class="markdown-rendered"
    tabindex="0"
    title="Click to edit"
    @click="startEditing"
    @keydown.enter.prevent="startEditing()"
  >
    <div v-if="text.trim()" v-html="html"></div>
    <p v-else class="placeholder">{{ placeholder }}</p>
  </div>
</template>

<style scoped>
.markdown-source,
.markdown-rendered {
  width: 100%;
  min-height: 6rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  font-size: 0.95rem;
}

.markdown-source {
  display: block;
  field-sizing: content;
  resize: vertical;
  background-color: var(--color-background-mute);
  font-family: ui-monospace, 'Iosevka Slab', monospace;
  line-height: 1.5;
  outline: none;
  border-color: var(--color-border-hover);
}

.markdown-rendered {
  cursor: text;
  background-color: transparent;
  overflow-wrap: anywhere;
}

.markdown-rendered:hover {
  border-color: var(--color-border-hover);
}

.markdown-rendered:focus-visible {
  outline: 2px solid var(--color-button);
  outline-offset: 2px;
}

.placeholder {
  color: var(--color-text-muted);
}

/* rendered markdown comes from v-html, so it needs :deep to be styled */
.markdown-rendered :deep(h1),
.markdown-rendered :deep(h2),
.markdown-rendered :deep(h3) {
  margin: 0.5rem 0 0.25rem;
  line-height: 1.3;
}

.markdown-rendered :deep(h1) {
  font-size: 1.3rem;
}

.markdown-rendered :deep(h2) {
  font-size: 1.15rem;
}

.markdown-rendered :deep(h3) {
  font-size: 1rem;
}

.markdown-rendered :deep(p),
.markdown-rendered :deep(ul),
.markdown-rendered :deep(ol),
.markdown-rendered :deep(pre),
.markdown-rendered :deep(blockquote) {
  margin: 0.25rem 0;
}

.markdown-rendered :deep(ul),
.markdown-rendered :deep(ol) {
  padding-left: 1.25rem;
}

.markdown-rendered :deep(code) {
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  background-color: var(--color-background-mute);
  font-family: ui-monospace, 'Iosevka Slab', monospace;
  font-size: 0.9em;
}

.markdown-rendered :deep(pre) {
  padding: 0.5rem;
  border-radius: 4px;
  background-color: var(--color-background-mute);
  overflow-x: auto;
}

.markdown-rendered :deep(pre code) {
  padding: 0;
}

.markdown-rendered :deep(blockquote) {
  padding-left: 0.75rem;
  border-left: 3px solid var(--color-border-hover);
  color: var(--color-text-muted);
}

.markdown-rendered :deep(a) {
  text-decoration: underline;
}
</style>
