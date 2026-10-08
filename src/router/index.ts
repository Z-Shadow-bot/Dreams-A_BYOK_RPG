import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'world', component: () => import('@/views/WorldView.vue') },
    { path: '/status', name: 'status', component: () => import('@/views/StatusView.vue') },
    { path: '/adventure', name: 'adventure', component: () => import('@/views/AdventureView.vue') },
    { path: '/archive', name: 'archive', component: () => import('@/views/ArchiveView.vue') },
    { path: '/mine', name: 'mine', component: () => import('@/views/MineView.vue') },
  ],
})

export default router