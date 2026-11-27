<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { runWxLoginStatusPoll } from '@/utils/wx-login-poll'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

type LoginTab = 'yyb_qr' | 'wx_qr'

const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<LoginTab>('yyb_qr')
const loginSettingsLoaded = ref(false)
const loginSettings = ref({
  yybQrLogin: true,
  wechatQrLogin: true,
})
let loginSettingsRequestVersion = 0

const qrTaskId = ref('')
const qrStatus = ref('')
const qrError = ref('')
const qrLoading = ref(false)
const qrUrl = ref('')
let pollTimer: ReturnType<typeof setTimeout> | undefined
let qrObjectUrl = ''
let flowVersion = 0
let pollController: AbortController | undefined
let pollInFlight: Promise<void> | undefined
let pollKey = ''
let pendingCode = ''
let pendingNickname = ''
let nameSubmitTimer: ReturnType<typeof setTimeout> | undefined

const yybQrLoginEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.yybQrLogin)
const wechatQrLoginEnabled = computed(() => loginSettingsLoaded.value && loginSettings.value.wechatQrLogin)
const scanEnabled = computed(() => activeLoginTab.value === 'yyb_qr' ? yybQrLoginEnabled.value : wechatQrLoginEnabled.value)

const form = reactive({
  name: '',
})

async function addAccount(code: string, nickname: string) {
  const name = (form.name.trim() || nickname || props.editData?.name || '').trim()
  if (!name) {
    pendingCode = code
    pendingNickname = nickname
    qrStatus.value = '登录授权已完成，请填写账号备注'
    qrError.value = '未获取到微信昵称，请填写账号备注'
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const payload: any = {
      name,
      code,
      platform: 'wx',
      loginType: 'wx_qr',
    }
    if (props.editData?.id)
      payload.id = props.editData.id
    const res = await api.post('/api/accounts', payload)
    if (res.data.ok) {
      emit('saved')
      close()
      return
    }
    errorMessage.value = `保存失败: ${getApiErrorMessage(res.data, '请求失败')}`
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${getApiErrorMessage(e, '请求失败')}`
  }
  finally {
    loading.value = false
  }
}

function clearNameSubmitTimer() {
  if (nameSubmitTimer) {
    clearTimeout(nameSubmitTimer)
    nameSubmitTimer = undefined
  }
}

async function submitPendingAccount() {
  if (!pendingCode || !form.name.trim() || !props.show)
    return
  const code = pendingCode
  const nickname = pendingNickname
  pendingCode = ''
  pendingNickname = ''
  await addAccount(code, nickname)
}

async function loadLoginSettings() {
  const requestVersion = ++loginSettingsRequestVersion
  loginSettingsLoaded.value = false
  try {
    const response = await api.get('/api/settings/login-config', { skipErrorToast: true } as any)
    if (requestVersion !== loginSettingsRequestVersion)
      return
    const data = response.data?.data
    loginSettings.value = {
      yybQrLogin: typeof data?.yybQrLogin === 'boolean' ? data.yybQrLogin : true,
      wechatQrLogin: typeof data?.wechatQrLogin === 'boolean' ? data.wechatQrLogin : true,
    }
  }
  catch {
    if (requestVersion !== loginSettingsRequestVersion)
      return
    loginSettings.value = { yybQrLogin: true, wechatQrLogin: true }
  }
  finally {
    if (requestVersion === loginSettingsRequestVersion) {
      const previousTab = activeLoginTab.value
      loginSettingsLoaded.value = true
      if (!scanEnabled.value)
        activeLoginTab.value = yybQrLoginEnabled.value ? 'yyb_qr' : 'wx_qr'
      // 标签没有变化时 watcher 不会触发，这里补一次；变化时交给 watcher。
      if (scanEnabled.value && activeLoginTab.value === previousTab && !qrTaskId.value)
        void startQrLogin()
    }
  }
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }
  pollController?.abort()
  pollController = undefined
}

function resetQrLogin() {
  const oldTaskId = qrTaskId.value
  flowVersion += 1
  stopPolling()
  if (oldTaskId)
    void api.delete(`/api/wx-login/tasks/${oldTaskId}`, { skipErrorToast: true } as any).catch(() => undefined)
  if (qrObjectUrl) {
    URL.revokeObjectURL(qrObjectUrl)
    qrObjectUrl = ''
  }
  qrTaskId.value = ''
  qrStatus.value = ''
  qrError.value = ''
  qrUrl.value = ''
  qrLoading.value = false
  pendingCode = ''
  pendingNickname = ''
  clearNameSubmitTimer()
}

function isFlowActive(taskId: string, version: number) {
  return version === flowVersion && taskId === qrTaskId.value
}

async function getCodeAndAdd(taskId: string, version: number) {
  if (!isFlowActive(taskId, version))
    return
  const codeResult = await api.post(`/api/wx-login/tasks/${taskId}/code`)
  if (!isFlowActive(taskId, version))
    return
  const code = String(codeResult.data?.data?.code || '').trim()
  const nickname = String(codeResult.data?.data?.nickname || '').trim()
  if (!code)
    throw new Error('未获取到登录 Code')
  qrStatus.value = '登录授权完成，正在保存账号...'
  await addAccount(code, nickname)
}

async function confirmLogin(taskId: string, version: number) {
  if (!isFlowActive(taskId, version))
    return
  qrStatus.value = '正在建立登录会话...'
  await api.post(`/api/wx-login/tasks/${taskId}/confirm`)
  if (!isFlowActive(taskId, version))
    return
  await getCodeAndAdd(taskId, version)
}

async function pollOnce(taskId: string, version: number) {
  if (!isFlowActive(taskId, version))
    return

  const controller = new AbortController()
  pollController = controller
  try {
    const response = await runWxLoginStatusPoll(() => api.get(`/api/wx-login/tasks/${taskId}/status`, {
      timeout: 40000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any))
    if (!isFlowActive(taskId, version))
      return
    const status = response.data?.data?.status
    if (status === 'waiting') {
      qrStatus.value = '等待扫码'
    }
    else if (status === 'scanned') {
      qrStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'authorized') {
      stopPolling()
      await confirmLogin(taskId, version)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      qrError.value = '二维码已失效，请重新获取'
      return
    }
    pollTimer = setTimeout(() => void pollQrLogin(taskId, version), 1200)
  }
  catch (error: any) {
    if (!isFlowActive(taskId, version) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    qrError.value = getApiErrorMessage(error, '登录状态检查失败')
  }
  finally {
    if (pollController === controller)
      pollController = undefined
  }
}

async function pollQrLogin(taskId: string, version: number) {
  if (!isFlowActive(taskId, version))
    return

  const previous = pollInFlight
  const previousKey = pollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isFlowActive(taskId, version))
      return
    if (previousKey === `${taskId}:${version}`)
      return
  }

  const current = pollOnce(taskId, version)
  pollInFlight = current
  pollKey = `${taskId}:${version}`
  try {
    await current
  }
  finally {
    if (pollInFlight === current) {
      pollInFlight = undefined
      pollKey = ''
    }
  }
}

async function startQrLogin() {
  if (!scanEnabled.value)
    return
  resetQrLogin()
  const version = flowVersion
  qrLoading.value = true
  try {
    const response = await api.post('/api/wx-login/tasks', { app_id: 'wx5306c5978fdb76e4' })
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (version !== flowVersion) {
      void api.delete(`/api/wx-login/tasks/${taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    qrTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, { responseType: 'blob' })
    if (!isFlowActive(taskId, version))
      return
    qrObjectUrl = URL.createObjectURL(qrResponse.data)
    qrUrl.value = qrObjectUrl
    qrStatus.value = activeLoginTab.value === 'yyb_qr' ? '请使用应用宝 / 微信扫码' : '请使用微信扫码'
    void pollQrLogin(taskId, version)
  }
  catch (error: any) {
    if (version !== flowVersion)
      return
    qrError.value = getApiErrorMessage(error, '二维码获取失败')
  }
  finally {
    if (version === flowVersion)
      qrLoading.value = false
  }
}

function close() {
  resetQrLogin()
  emit('close')
}

watch(() => props.show, (visible) => {
  if (!visible)
    return
  errorMessage.value = ''
  activeLoginTab.value = 'yyb_qr'
  resetQrLogin()
  form.name = props.editData?.name || ''
  void loadLoginSettings()
})

watch(activeLoginTab, () => {
  resetQrLogin()
  if (scanEnabled.value)
    void startQrLogin()
})

watch(() => form.name, () => {
  clearNameSubmitTimer()
  if (!pendingCode || !form.name.trim())
    return
  nameSubmitTimer = setTimeout(() => void submitPendingAccount(), 800)
})

onBeforeUnmount(() => {
  resetQrLogin()
})
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading && !qrLoading"
    :close-on-esc="!loading && !qrLoading"
    @update:show="value => !value && close()"
  >
    <NCard
      class="account-modal-card"
      :title="editData ? '重新扫码登录' : '添加账号'"
      :bordered="false"
      :closable="!loading && !qrLoading"
      @close="close"
    >
      <div class="account-modal-content dialog-scroll overflow-y-auto">
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <NTabs v-if="loginSettingsLoaded" v-model:value="activeLoginTab" class="mb-4" type="line">
          <NTab v-if="yybQrLoginEnabled" name="yyb_qr">
            应用宝扫码登录
          </NTab>
          <NTab v-if="wechatQrLoginEnabled" name="wx_qr">
            微信扫码登录
          </NTab>
        </NTabs>

        <div v-if="loginSettingsLoaded && scanEnabled" class="space-y-4" role="tabpanel" :aria-label="activeLoginTab === 'yyb_qr' ? '应用宝扫码登录' : '微信扫码登录'">
          <BaseInput
            v-model="form.name"
            label="账号备注（可留空）"
            placeholder="留空时使用微信昵称"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="qrUrl" class="bg-white p-2">
              <img :src="qrUrl" alt="扫码登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ qrLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ qrStatus }}
            </p>
            <p v-if="qrError" class="text-sm text-red-500">
              {{ qrError }}
            </p>
            <p class="text-xs text-center opacity-60">
              应用宝与微信共用同一登录渠道；扫码后掉线会自动尝试重连，无需再次扫码。
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton v-if="pendingCode" variant="primary" :loading="loading" :disabled="!form.name.trim()" @click="submitPendingAccount">
              保存账号
            </BaseButton>
            <BaseButton variant="outline" :loading="qrLoading" @click="startQrLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else-if="loginSettingsLoaded" class="rounded-xl p-4 text-sm opacity-70">
          扫码登录已在「设置 → 登录与自动重连」中关闭，请先开启应用宝或微信扫码。
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.account-modal-card {
  width: min(448px, calc(100vw - 32px));
}

.account-modal-content {
  max-height: calc(90vh - 100px);
}
</style>
