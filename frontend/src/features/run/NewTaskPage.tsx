import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import type { Platform, PlatformSelection, TaskKind } from '../../api/contracts';
import { api } from '../../api/client';
import { ErrorState, PageHeader, PLATFORM_LABELS, Section, SuccessNotice } from '../../components/ui';
import { FilterBuilder } from './FilterBuilder';

type Mode = 'resume-capture' | 'batch' | 'talent-mapping' | 'search-subscription' | 'boss-auto-chat' | 'login-refresh';

interface FormState {
  platform: PlatformSelection;
  keyword: string;
  jd: string;
  jdFile: string;
  jobsFile: string;
  talentMappingFile: string;
  searchSubscriptionFile: string;
  searchSubscriptionName: string;
  saveSearchSubscription: boolean;
  includeViewed: boolean;
  searchSource: '' | 'saved' | 'direct';
  applicationFilterInputFile: string;
  email: string;
  cc: string;
  liepinForwardContact: string;
  bossForwardMode: '' | 'colleague' | 'email';
  bossForwardRecipient: string;
  scoreThreshold: string;
  requireAllHardRequirements: boolean;
  replyToUnqualifiedCandidates: boolean;
  summaryEmail: string;
  summaryCc: string;
  syncJobsBeforeReview: boolean;
}

const initialForm: FormState = {
  platform: '51job', keyword: '', jd: '', jdFile: '', jobsFile: '', talentMappingFile: '', searchSubscriptionFile: '', searchSubscriptionName: '', saveSearchSubscription: false,
  includeViewed: false, searchSource: '', applicationFilterInputFile: '', email: '', cc: '', liepinForwardContact: '', bossForwardMode: '', bossForwardRecipient: '',
  scoreThreshold: '70', requireAllHardRequirements: true, replyToUnqualifiedCandidates: false, summaryEmail: '', summaryCc: '', syncJobsBeforeReview: false,
};

export function NewTaskPage() {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(searchParams.get('mode') === 'talent-mapping' ? 'talent-mapping' : 'resume-capture');
  const [form, setForm] = useState(initialForm);
  const [validationError, setValidationError] = useState<string>();
  const mutation = useMutation({ mutationFn: ({ kind, body }: { kind: TaskKind; body: Record<string, unknown> }) => api.submitTask(kind, body) });
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setModeSafe = (next: Mode) => {
    setMode(next);
    setValidationError(undefined);
    if (next === 'boss-auto-chat') set('platform', 'boss');
    if (next === 'login-refresh' && form.platform === 'all') set('platform', '51job');
    if (next === 'talent-mapping' && form.platform === 'boss') set('platform', '51job');
  };

  const submit = () => {
    setValidationError(undefined);
    let body: Record<string, unknown>;
    if (mode === 'resume-capture') {
      if (!form.keyword.trim()) return setValidationError('关键词必填');
      if (form.jd && form.jdFile) return setValidationError('JD 文本和 JD 文件不能同时填写');
      body = commonBody(form);
      body.keyword = form.keyword.trim();
      body.jd = form.jd.trim() || undefined;
      body.jdFile = form.jdFile.trim() || undefined;
    } else if (mode === 'batch') {
      if (!form.jobsFile.trim()) return setValidationError('批量任务文件必填');
      body = { ...commonBody(form), jobsFile: form.jobsFile.trim() };
    } else if (mode === 'talent-mapping') {
      if (!form.talentMappingFile.trim()) return setValidationError('Talent Mapping 计划文件必填');
      if (form.platform === 'boss') return setValidationError('核心 Talent Mapping 不支持 Boss');
      body = { platform: form.platform, talentMappingFile: form.talentMappingFile.trim(), mappingStage: 'scan' };
    } else if (mode === 'search-subscription') {
      if (!form.searchSubscriptionFile.trim()) return setValidationError('搜索订阅文件必填');
      body = { platform: form.platform, searchSubscriptionFile: form.searchSubscriptionFile.trim(), keyword: form.keyword.trim() || undefined, applicationFilterInputFile: form.applicationFilterInputFile.trim() || undefined, saveSearchSubscription: form.saveSearchSubscription, searchSubscriptionName: form.searchSubscriptionName.trim() || undefined };
    } else if (mode === 'boss-auto-chat') {
      if (Boolean(form.bossForwardMode) !== Boolean(form.bossForwardRecipient.trim())) return setValidationError('Boss 转发方式和收件人必须同时填写');
      body = { platform: 'boss', scoreThreshold: Number(form.scoreThreshold), requireAllHardRequirements: form.requireAllHardRequirements, replyToUnqualifiedCandidates: form.replyToUnqualifiedCandidates, bossForwardMode: form.bossForwardMode || undefined, bossForwardRecipient: form.bossForwardRecipient.trim() || undefined, summaryEmail: form.summaryEmail.trim() || undefined, summaryCc: splitList(form.summaryCc), syncJobsBeforeReview: form.syncJobsBeforeReview };
    } else {
      body = { platform: form.platform };
    }
    mutation.mutate({ kind: mode, body });
  };
  const singlePlatform = form.platform === 'all' ? undefined : form.platform as Platform;
  const showFilter = mode === 'search-subscription' || ((mode === 'resume-capture' || mode === 'batch') && form.searchSource === 'direct');

  return (
    <div className="page-stack">
      <PageHeader eyebrow="NEW TASK" title="新建任务" description="所有任务在服务端重新规范化后进入共享串行队列；页面预览不是执行来源。" />
      <Section>
        <div className="segmented">{([['resume-capture', '简历抓取'], ['batch', '批量任务'], ['talent-mapping', '人才地图扫描'], ['search-subscription', '搜索订阅'], ['boss-auto-chat', 'Boss 自动沟通'], ['login-refresh', '登录刷新']] as const).map(([value, label]) => <button type="button" className={mode === value ? 'active' : ''} key={value} onClick={() => setModeSafe(value)}>{label}</button>)}</div>
      </Section>
      <Section title="任务参数" description={mode === 'boss-auto-chat' ? 'Boss 是单平台独立模式。' : mode === 'talent-mapping' ? '此入口只执行卡片扫描；详情补全需在人才地图项目页核对精确人数并逐轮确认。' : '全部平台只包含 51job、猎聘和智联，不包含 Boss。'}>
        <div className="form-grid">
          <label><span>平台</span><select value={form.platform} onChange={(event) => set('platform', event.target.value as PlatformSelection)} disabled={mode === 'boss-auto-chat'}>{(mode === 'boss-auto-chat' ? ['boss'] : mode === 'login-refresh' ? ['51job', 'liepin', 'zhilian', 'boss'] : mode === 'talent-mapping' ? ['51job', 'liepin', 'zhilian', 'all'] : ['51job', 'liepin', 'zhilian', 'boss', 'all']).map((item) => <option value={item} key={item}>{PLATFORM_LABELS[item as keyof typeof PLATFORM_LABELS]}</option>)}</select></label>
          {(mode === 'resume-capture' || mode === 'search-subscription') && <label><span>关键词</span><input value={form.keyword} onChange={(event) => set('keyword', event.target.value)} placeholder="例如：Java 后端" /></label>}
          {mode === 'batch' && <label><span>批量任务文件</span><input value={form.jobsFile} onChange={(event) => set('jobsFile', event.target.value)} placeholder="./jobs.json" /></label>}
          {mode === 'talent-mapping' && <><label className="wide"><span>Talent Mapping 计划文件</span><input value={form.talentMappingFile} onChange={(event) => set('talentMappingFile', event.target.value)} placeholder="./mapping/retail-operations.json" /></label><div className="security-note wide">计划文件必须显式设置批次、候选和详情上限。扫描不会写岗位、seen、评分、邮件或 RAG；完成扫描后从“人才地图”项目页发起详情补全。</div></>}
          {mode === 'search-subscription' && <><label><span>订阅文件</span><input value={form.searchSubscriptionFile} onChange={(event) => set('searchSubscriptionFile', event.target.value)} placeholder="./search-subscription.json" /></label><label><span>订阅名称</span><input value={form.searchSubscriptionName} onChange={(event) => set('searchSubscriptionName', event.target.value)} /></label><label className="checkbox-field"><input type="checkbox" checked={form.saveSearchSubscription} onChange={(event) => set('saveSearchSubscription', event.target.checked)} />保存平台订阅</label></>}
          {mode === 'resume-capture' && <><label className="wide"><span>JD 文本</span><textarea value={form.jd} onChange={(event) => set('jd', event.target.value)} rows={6} /></label><label><span>JD 文件</span><input value={form.jdFile} onChange={(event) => set('jdFile', event.target.value)} placeholder="./jd.txt" /></label></>}
          {(mode === 'resume-capture' || mode === 'batch') && <><label><span>搜索来源</span><select value={form.searchSource} onChange={(event) => set('searchSource', event.target.value as FormState['searchSource'])}><option value="">复用岗位设置</option><option value="saved">已保存搜索</option><option value="direct">直接搜索</option></select></label><label className="checkbox-field"><input type="checkbox" checked={form.includeViewed} onChange={(event) => set('includeViewed', event.target.checked)} />包含已查看候选人</label></>}
          {showFilter && <label><span>筛选条件文件</span><input value={form.applicationFilterInputFile} onChange={(event) => set('applicationFilterInputFile', event.target.value)} placeholder="由下方构建器生成或填写路径" /></label>}
          {(mode === 'resume-capture' || mode === 'batch') && <><label><span>报告邮箱</span><input type="email" value={form.email} onChange={(event) => set('email', event.target.value)} /></label><label><span>抄送</span><input value={form.cc} onChange={(event) => set('cc', event.target.value)} placeholder="逗号分隔" /></label></>}
          {(form.platform === 'liepin' || form.platform === 'all') && (mode === 'resume-capture' || mode === 'batch') && <label><span>猎聘转发联系人</span><input value={form.liepinForwardContact} onChange={(event) => set('liepinForwardContact', event.target.value)} /></label>}
          {form.platform === 'boss' && (mode === 'resume-capture' || mode === 'batch' || mode === 'boss-auto-chat') && <><label><span>Boss 转发方式</span><select value={form.bossForwardMode} onChange={(event) => set('bossForwardMode', event.target.value as FormState['bossForwardMode'])}><option value="">不转发</option><option value="colleague">站内同事</option><option value="email">邮件</option></select></label><label><span>Boss 转发收件人</span><input value={form.bossForwardRecipient} onChange={(event) => set('bossForwardRecipient', event.target.value)} /></label></>}
          {mode === 'boss-auto-chat' && <><label className="checkbox-field"><input type="checkbox" checked={form.requireAllHardRequirements} onChange={(event) => set('requireAllHardRequirements', event.target.checked)} />所有硬性要求必须满足</label>{!form.requireAllHardRequirements && <label><span>评分线</span><input type="number" min="0" max="100" value={form.scoreThreshold} onChange={(event) => set('scoreThreshold', event.target.value)} /></label>}<label className="checkbox-field"><input type="checkbox" checked={form.replyToUnqualifiedCandidates} onChange={(event) => set('replyToUnqualifiedCandidates', event.target.checked)} />回复不合适候选人</label><label className="checkbox-field"><input type="checkbox" checked={form.syncJobsBeforeReview} onChange={(event) => set('syncJobsBeforeReview', event.target.checked)} />审查前同步职位/JD</label><label><span>总结邮件</span><input type="email" value={form.summaryEmail} onChange={(event) => set('summaryEmail', event.target.value)} /></label><label><span>总结抄送</span><input value={form.summaryCc} onChange={(event) => set('summaryCc', event.target.value)} /></label></>}
        </div>
        <div className="form-actions"><button className="primary-button" type="button" disabled={mutation.isPending} onClick={submit}><Play size={16} />{mutation.isPending ? '提交中' : mode === 'talent-mapping' ? '提交扫描任务' : '提交任务'}</button></div>
      </Section>
      {validationError && <ErrorState error={new Error(validationError)} />}{mutation.error && <ErrorState error={mutation.error} />}
      {mutation.data && <SuccessNotice><CheckCircle2 size={18} />任务已创建：<Link className="text-link" to={`/tasks/${encodeURIComponent(mutation.data.taskId)}`}>{mutation.data.taskId}</Link></SuccessNotice>}
      {showFilter && <FilterBuilder platform={singlePlatform} onSaved={(path) => set('applicationFilterInputFile', path)} />}
    </div>
  );
}

function splitList(value: string): string[] | undefined {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function commonBody(form: FormState): Record<string, unknown> {
  return {
    platform: form.platform,
    includeViewed: form.includeViewed,
    searchSource: form.searchSource || undefined,
    applicationFilterInputFile: form.searchSource === 'direct' ? form.applicationFilterInputFile.trim() || undefined : undefined,
    email: form.email.trim() || undefined,
    cc: splitList(form.cc),
    liepinForwardContact: form.platform === 'liepin' || form.platform === 'all' ? form.liepinForwardContact.trim() || undefined : undefined,
    bossForwardMode: form.platform === 'boss' ? form.bossForwardMode || undefined : undefined,
    bossForwardRecipient: form.platform === 'boss' ? form.bossForwardRecipient.trim() || undefined : undefined,
  };
}
