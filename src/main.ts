import { createApp } from 'vue';
import App from './App.vue';
// Canonical styling for the bar-control component family
// (BarLabel / BarButton / BarButtonGroup / BarControlGroup).
// Loaded once at app boot so both the bottom bars (which still use
// bare HTML with the same class names) and the GAME LOBBY's
// component-based controls share one source of truth.
import './styles/barControls.css';

createApp(App).mount('#app');
