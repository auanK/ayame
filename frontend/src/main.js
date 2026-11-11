import { createApp } from 'vue'
import App from './App.vue'
import { createAyameRouter } from './router/index.js'
import './styles/main.css'

const app = createApp(App)
app.use(createAyameRouter())
app.mount('#app')
