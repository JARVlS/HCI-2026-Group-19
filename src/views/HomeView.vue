<script setup lang="ts">
import Introduction from '../components/Introduction.vue'
import Graph from '../components/Graph.vue'
import AddGraphNodes from '../components/AddGraphNodes.vue'
import GraphDetails from '../components/GraphDetails.vue'
import ResizeHandle from '../components/ResizeHandle.vue'
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import type { Ref } from 'vue'
import {
  childIds,
  updateAverages,
  type GraphData,
  type GraphLink,
  type GraphNode,
  type IndependenceLevel,
} from '@/types/graph'

const name = ref(localStorage.getItem('Name') || '')

// exercise and course levels are placeholders, they are averaged from their concepts on load
const graph_data: Ref<GraphData> = ref({
  nodes: [
    // Visual Computing
    {
      id: 'Visual Computing',
      independence: 0,
      summary:
        'Computer vision and graphics, taught through weekly Python exercise sheets. The vision half covers filtering, the Fourier transform, local features, segmentation and learned classifiers; each exercise builds on the concepts from the previous ones.',
    },
    {
      id: 'VC Ex1 · Image Filtering',
      independence: 0,
      summary:
        'Implement 2D convolution from scratch, smooth images with Gaussian kernels of different widths and compute image gradients with Sobel filters to find edges.',
    },
    {
      id: 'VC Ex2 · Fourier Transform',
      independence: 0,
      summary:
        'Move images into the frequency domain with the DFT, verify the convolution theorem numerically and show aliasing when downsampling without a low-pass filter.',
    },
    {
      id: 'VC Ex3 · Corners & Optical Flow',
      independence: 0,
      summary:
        'Detect Harris corners from the structure tensor of image gradients, then estimate motion between two frames with Lucas–Kanade on small windows.',
    },
    {
      id: 'VC Ex4 · Segmentation',
      independence: 0,
      summary:
        'Segment images by clustering pixel colours with k-means and compare the result with a graph-cut segmentation that also rewards smooth region boundaries.',
    },
    {
      id: 'VC Ex5 · Image Classification',
      independence: 0,
      summary:
        'Train and evaluate a classifier on the Caltech-6 dataset: define a loss, optimise it with gradient descent and judge overfitting from train and test accuracy.',
    },
    {
      id: 'Convolution',
      independence: 80,
      summary:
        'Slides a flipped kernel over the image and sums the weighted neighbourhood at each pixel. Linear and shift-invariant; border handling (zero, mirror, wrap) changes the result at the edges.',
    },
    {
      id: 'Gaussian Smoothing',
      independence: 90,
      summary:
        'Blurs with a Gaussian kernel whose width σ sets how much fine detail is removed. Separable, so a 2D blur can be done as two 1D passes.',
    },
    {
      id: 'Image Gradients',
      independence: 60,
      summary:
        'Derivatives in x and y, usually approximated with Sobel kernels. Gradient magnitude marks edges, gradient direction is perpendicular to them.',
    },
    {
      id: 'Discrete Fourier Transform',
      independence: 40,
      summary:
        'Writes an image as a sum of 2D sinusoids. The magnitude spectrum shows which frequencies are present; low frequencies hold coarse structure, high frequencies edges and noise.',
    },
    {
      id: 'Convolution Theorem',
      independence: 50,
      summary:
        'Convolution in the spatial domain equals pointwise multiplication in the frequency domain, which makes large filters cheap via the FFT.',
    },
    {
      id: 'Aliasing & Nyquist Sampling',
      independence: 30,
      summary:
        'Sampling below twice the highest frequency folds high frequencies into low ones. Low-pass filter before downsampling to avoid it.',
    },
    {
      id: 'Harris Corner Detector',
      independence: 50,
      summary:
        'Builds the structure tensor from gradients in a window; both eigenvalues large means a corner. The Harris response det − k·trace² avoids computing eigenvalues.',
    },
    {
      id: 'Lucas–Kanade Optical Flow',
      independence: 20,
      summary:
        'Assumes brightness constancy and constant flow in a small window, which turns the aperture problem into a solvable least-squares system per window.',
    },
    {
      id: 'K-Means Clustering',
      independence: 70,
      summary:
        'Alternates between assigning each pixel to the nearest cluster centre and moving centres to the mean of their pixels. Needs k up front and depends on initialisation.',
    },
    {
      id: 'Graph-Cut Segmentation',
      independence: 20,
      summary:
        'Treats pixels as graph nodes and finds the minimum cut that balances how well each pixel fits a label against the cost of cutting between similar neighbours.',
    },
    {
      id: 'Linear Classifiers & Loss',
      independence: 40,
      summary:
        'Scores each class with a weighted sum of features; a loss such as softmax cross-entropy measures how wrong the scores are on the training data.',
    },
    {
      id: 'Gradient Descent',
      independence: 60,
      summary:
        'Repeatedly steps the parameters against the gradient of the loss. The learning rate trades speed against stability; stochastic variants use mini-batches.',
    },
    {
      id: 'Train/Test Split & Overfitting',
      independence: 70,
      summary:
        'Evaluate on data the model never saw. High training but low test accuracy means overfitting; a confusion matrix shows which classes get mixed up.',
    },

    // Introduction to Neuroinformatics
    {
      id: 'Introduction To Neuroinformatics',
      independence: 0,
      summary:
        'How neurons and networks of neurons compute, from the biophysics of a single membrane to spiking models and simple learning rules. Exercises are mostly short simulations of the models from the lecture.',
    },
    {
      id: 'NI Ex1 · Passive Membrane',
      independence: 0,
      summary:
        'Compute reversal potentials for the main ions and model the passive membrane as an RC circuit to predict how voltage responds to an injected current step.',
    },
    {
      id: 'NI Ex2 · Hodgkin–Huxley Simulation',
      independence: 0,
      summary:
        'Simulate the Hodgkin–Huxley equations numerically and explain the shape of the action potential from the dynamics of the gating variables.',
    },
    {
      id: 'NI Ex3 · Integrate-and-Fire',
      independence: 0,
      summary:
        'Implement a leaky integrate-and-fire neuron, add threshold and reset, and measure its firing rate as a function of input current.',
    },
    {
      id: 'NI Ex4 · Perceptron Learning',
      independence: 0,
      summary:
        'Train a perceptron on a linearly separable problem and compare the error-driven perceptron rule with unsupervised Hebbian learning.',
    },
    {
      id: 'Nernst Potential',
      independence: 50,
      summary:
        'The membrane voltage at which an ion’s concentration gradient and electrical force balance. Each ion species has its own reversal potential.',
    },
    {
      id: 'Membrane RC Circuit',
      independence: 30,
      summary:
        'The lipid bilayer acts as a capacitor and the ion channels as resistors. The time constant τ = RC sets how quickly the voltage follows the input.',
    },
    {
      id: 'Gating Variables (m, h, n)',
      independence: 10,
      summary:
        'Voltage-dependent probabilities that channel gates are open, each following first-order kinetics. Fast m activates Na⁺, slower h inactivates it and n activates K⁺.',
    },
    {
      id: 'Euler Integration of ODEs',
      independence: 40,
      summary:
        'Approximates a differential equation by stepping forward with the current derivative. Simple, but the time step must be small enough to stay stable.',
    },
    {
      id: 'Threshold & Reset',
      independence: 30,
      summary:
        'Instead of modelling the spike itself, the voltage is reset when it crosses a threshold and a spike time is recorded, optionally followed by a refractory period.',
    },
    {
      id: 'f–I Curve',
      independence: 20,
      summary:
        'Firing rate as a function of constant input current. Zero below the rheobase, then rising; its shape can be derived analytically for the LIF neuron.',
    },
    {
      id: 'Perceptron Rule',
      independence: 30,
      summary:
        'Adds or subtracts the input from the weights whenever the output is wrong. Converges if and only if the data is linearly separable.',
    },
    {
      id: 'Hebbian Learning',
      independence: 20,
      summary:
        '“Cells that fire together wire together”: weights grow with correlated pre- and postsynaptic activity, so without normalisation they grow without bound.',
    },
  ],
  links: [
    { source: 'Visual Computing', target: 'VC Ex1 · Image Filtering' },
    { source: 'Visual Computing', target: 'VC Ex2 · Fourier Transform' },
    { source: 'Visual Computing', target: 'VC Ex3 · Corners & Optical Flow' },
    { source: 'Visual Computing', target: 'VC Ex4 · Segmentation' },
    { source: 'Visual Computing', target: 'VC Ex5 · Image Classification' },
    { source: 'VC Ex1 · Image Filtering', target: 'Convolution' },
    { source: 'VC Ex1 · Image Filtering', target: 'Gaussian Smoothing' },
    { source: 'VC Ex1 · Image Filtering', target: 'Image Gradients' },
    { source: 'VC Ex2 · Fourier Transform', target: 'Discrete Fourier Transform' },
    { source: 'VC Ex2 · Fourier Transform', target: 'Convolution Theorem' },
    { source: 'VC Ex2 · Fourier Transform', target: 'Aliasing & Nyquist Sampling' },
    { source: 'VC Ex2 · Fourier Transform', target: 'Convolution' },
    { source: 'VC Ex3 · Corners & Optical Flow', target: 'Image Gradients' },
    { source: 'VC Ex3 · Corners & Optical Flow', target: 'Harris Corner Detector' },
    { source: 'VC Ex3 · Corners & Optical Flow', target: 'Lucas–Kanade Optical Flow' },
    { source: 'VC Ex4 · Segmentation', target: 'K-Means Clustering' },
    { source: 'VC Ex4 · Segmentation', target: 'Graph-Cut Segmentation' },
    { source: 'VC Ex5 · Image Classification', target: 'Linear Classifiers & Loss' },
    { source: 'VC Ex5 · Image Classification', target: 'Gradient Descent' },
    { source: 'VC Ex5 · Image Classification', target: 'Train/Test Split & Overfitting' },

    { source: 'Introduction To Neuroinformatics', target: 'NI Ex1 · Passive Membrane' },
    { source: 'Introduction To Neuroinformatics', target: 'NI Ex2 · Hodgkin–Huxley Simulation' },
    { source: 'Introduction To Neuroinformatics', target: 'NI Ex3 · Integrate-and-Fire' },
    { source: 'Introduction To Neuroinformatics', target: 'NI Ex4 · Perceptron Learning' },
    { source: 'NI Ex1 · Passive Membrane', target: 'Nernst Potential' },
    { source: 'NI Ex1 · Passive Membrane', target: 'Membrane RC Circuit' },
    { source: 'NI Ex2 · Hodgkin–Huxley Simulation', target: 'Gating Variables (m, h, n)' },
    { source: 'NI Ex2 · Hodgkin–Huxley Simulation', target: 'Euler Integration of ODEs' },
    { source: 'NI Ex2 · Hodgkin–Huxley Simulation', target: 'Membrane RC Circuit' },
    { source: 'NI Ex3 · Integrate-and-Fire', target: 'Euler Integration of ODEs' },
    { source: 'NI Ex3 · Integrate-and-Fire', target: 'Threshold & Reset' },
    { source: 'NI Ex3 · Integrate-and-Fire', target: 'f–I Curve' },
    { source: 'NI Ex4 · Perceptron Learning', target: 'Perceptron Rule' },
    { source: 'NI Ex4 · Perceptron Learning', target: 'Hebbian Learning' },
    { source: 'NI Ex4 · Perceptron Learning', target: 'Gradient Descent' },
  ],
})
updateAverages(graph_data.value)

// id of the node clicked in the graph, shared with the add form (as the parent) and the details panel
const selected_node = ref<string | null>(null)

// edits the node object in place: force-graph holds the same objects and links point at them,
// so replacing the node would detach it from the graph; parents follow via the averages
function setIndependence(id: string, level: IndependenceLevel) {
  const node = graph_data.value.nodes.find((n) => n.id === id)
  if (!node || childIds(graph_data.value, id).length) return
  node.independence = level
  updateAverages(graph_data.value)
}

// build from the raw arrays so force-graph keeps working on plain objects
// (it has already replaced link source/target strings with node objects)
function setGraph(nodes: GraphNode[], links: GraphLink[]) {
  const data = { nodes, links }
  updateAverages(data)
  graph_data.value = data
}

function addNode(node: GraphNode, parent: string | null) {
  const raw = toRaw(graph_data.value)
  const links = parent === null ? raw.links : [...raw.links, { source: parent, target: node.id }]
  setGraph([...raw.nodes, node], links)
}

function addLink(source: string, target: string) {
  const raw = toRaw(graph_data.value)
  if (childIds(raw, source).includes(target)) return
  setGraph(raw.nodes, [...raw.links, { source, target }])
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
    <AddGraphNodes :data="graph_data" v-model:selected="selected_node" @add-node="addNode" />
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
      @add-link="addLink"
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
