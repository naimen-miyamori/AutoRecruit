import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Play } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Platform, PlatformSelection, SearchConditionSetRef, TaskKind } from '../../api/contracts';
import { api, queryKeys } from '../../api/client';
import { ErrorState, LoadingState, PageHeader, PLATFORM_LABELS, Section, SuccessNotice } from '../../components/ui';
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
  includeBoss: boolean;
  searchSource: '' | 'saved' | 'direct';
  applicationFilterInputFile: string;
  searchConditionSetRefs: Partial<Record<Platform, SearchConditionSetRef>>;
  email: string;
  cc: string;
  liepinForwardContact: string;
  bossJobId: string;
  bossSearchKeyword: string;
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
  includeViewed: false, includeBoss: false, searchSource: '', applicationFilterInputFile: '', searchConditionSetRefs: {}, email: '', cc: '', liepinForwardContact: '', bossJobId: '', bossSearchKeyword: '', bossForwardMode: '', bossForwardRecipient: '',
  scoreThreshold: '70', requireAllHardRequirements: true, replyToUnqualifiedCandidates: false, summaryEmail: '', summaryCc: '', syncJobsBeforeReview: false,
};

function hasReferences(form: FormState): boolean {
  return Object.keys(form.searchConditionSetRefs).length > 0;
}

function targetPlatforms(form: FormState, mode: Mode): Platform[] {
  if (form.platform !== 'all') return [form.platform];
  const platforms: Platform[] = ['51job', 'liepin', 'zhilian'];
  if (form.includeBoss && (mode === 'resume-capture' || mode === 'batch')) platforms.push('boss');
  return platforms;
}

function refsForTargetPlatforms(form: FormState, mode: Mode): Partial<Record<Platform, SearchConditionSetRef>> | undefined {
  const entries = targetPlatforms(form, mode)
    .map((platform) => [platform, form.searchConditionSetRefs[platform]] as const)
    .filter((entry): entry is readonly [Platform, SearchConditionSetRef] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) as Partial<Record<Platform, SearchConditionSetRef>> : undefined;
}

function ConditionSetSelector({ platform, value, onChange }: { platform: Platform; value?: SearchConditionSetRef; onChange: (value?: SearchConditionSetRef) => void }) {
  const query = useQuery({
    queryKey: queryKeys.searchConditionSets(platform, 'active'),
    queryFn: ({ signal }) => api.listSearchConditionSets(platform, 'active', signal),
  });
  const options = (query.data?.conditionSets ?? []).filter((item) => item.status === 'active' && item.compatibility?.status !== 'incompatible');
  return <label className="condition-set-selector"><span>{PLATFORM_LABELS[platform]} 条件集</span>{query.isLoading ? <LoadingState label="读取条件集" /> : <select value={value ? `${value.conditionSetId}@${value.revision}` : ''} onChange={(event) => {
    const selected = options.find((item) => `${item.conditionSetId}@${item.revision}` === event.target.value);
    onChange(selected ? { conditionSetId: selected.conditionSetId, platform: selected.platform, revision: selected.revision } : undefined);
  }}><option value="">不使用条件集</option>{options.map((item) => <option key={`${item.conditionSetId}-${item.revision}`} value={`${item.conditionSetId}@${item.revision}`}>{item.name} · r{item.revision}{item.compatibility?.status === 'drifted' ? '（目录有变化）' : ''}</option>)}</select>}{query.error && <small className="inline-error">无法读取条件集：{query.error instanceof Error ? query.error.message : String(query.error)}</small>}{value && <small>已固定：{value.conditionSetId} · revision {value.revision}</small>}{!query.isLoading && options.length === 0 && <small>暂无可选条件集。可在下方创建，或前往“搜索条件集”管理。</small>}</label>;
}

export function NewTaskPage() {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(searchParams.get('mode') === 'talent-mapping' ? 'talent-mapping' : 'resume-capture');
  const [form, setForm] = useState(initialForm);
  const [validationError, setValidationError] = useState<string>();
  const mutation = useMutation({ mutationFn: ({ kind, body }: { kind: TaskKind; body: Record<string, unknown> }) => api.submitTask(kind, body) });
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setConditionSetReference = (platform: Platform, value?: SearchConditionSetRef) => setForm((current) => {
    const refs = { ...current.searchConditionSetRefs };
    if (value) refs[platform] = value; else delete refs[platform];
    return { ...current, searchConditionSetRefs: refs, applicationFilterInputFile: value ? '' : current.applicationFilterInputFile };
  });
  const setLegacyFilterFile = (value: string) => setForm((current) => ({ ...current, applicationFilterInputFile: value, searchConditionSetRefs: value.trim() ? {} : current.searchConditionSetRefs }));
  const setModeSafe = (next: Mode) => {
    setMode(next);
    setValidationError(undefined);
    if (next === 'boss-auto-chat') set('platform', 'boss');
    if (next === 'login-refresh' && form.platform === 'all') set('platform', '51job');
    if (next === 'talent-mapping' && form.platform === 'boss') set('platform', '51job');
  };
  const showFilter = mode === 'search-subscription' || ((mode === 'resume-capture' || mode === 'batch') && form.searchSource === 'direct');
  const selectedPlatforms = targetPlatforms(form, mode);
  const showBossSavedJob = mode === 'resume-capture' && (form.platform === 'boss' || (form.platform === 'all' && form.includeBoss));
  const bossPositionsQuery = useQuery({
    queryKey: queryKeys.bossPositions,
    queryFn: ({ signal }) => api.listBossPositions(signal),
    enabled: showBossSavedJob,
  });
  const selectedBossPosition = bossPositionsQuery.data?.positions.find((position) => position.bossJobId === form.bossJobId);
  const selectedBossJobQuery = useQuery({
    queryKey: queryKeys.job('boss', selectedBossPosition?.jobKey ?? ''),
    queryFn: ({ signal }) => api.getJob('boss', selectedBossPosition?.jobKey ?? '', signal),
    enabled: Boolean(selectedBossPosition?.jobKey),
  });
  const selectedBossSearchSettings = selectedBossJobQuery.data?.jobRecord?.searchSettings;
  const savedBossConditionSetQuery = useQuery({
    queryKey: queryKeys.searchConditionSet(selectedBossSearchSettings?.conditionSetRef?.conditionSetId ?? ''),
    queryFn: ({ signal }) => api.getSearchConditionSet(selectedBossSearchSettings?.conditionSetRef?.conditionSetId ?? '', signal),
    enabled: Boolean(selectedBossSearchSettings?.conditionSetRef?.conditionSetId),
  });
  const savedBossDefaultKeyword = savedBossConditionSetQuery.data?.conditionSet.defaultKeyword;
  const selectBossJob = (bossJobId: string) => setForm((current) => {
    const selected = bossPositionsQuery.data?.positions.find((position) => position.bossJobId === bossJobId);
    return {
      ...current,
      bossJobId,
      keyword: selected?.name ?? current.keyword,
    };
  });

  const submit = () => {
    setValidationError(undefined);
    if (hasReferences(form) && form.applicationFilterInputFile.trim()) return setValidationError('条件集与旧筛选文件互斥；请只保留一种筛选来源。');
    if ((mode === 'resume-capture' || mode === 'batch') && hasReferences(form) && form.searchSource !== 'direct') return setValidationError('条件集只能用于直接搜索，请将搜索来源设为“直接搜索”。');
    let body: Record<string, unknown>;
    if (mode === 'resume-capture') {
      if (!form.keyword.trim()) return setValidationError('关键词必填');
      if (form.jd && form.jdFile) return setValidationError('JD 文本和 JD 文件不能同时填写');
      if ((form.platform === 'boss' || (form.platform === 'all' && form.includeBoss)) && Boolean(form.bossForwardMode) !== Boolean(form.bossForwardRecipient.trim())) return setValidationError('Boss 转发方式和收件人必须同时填写');
      body = commonBody(form, mode);
      body.keyword = form.keyword.trim();
      body.jd = form.jd.trim() || undefined;
      body.jdFile = form.jdFile.trim() || undefined;
    } else if (mode === 'batch') {
      if (!form.jobsFile.trim()) return setValidationError('批量任务文件必填');
      if ((form.platform === 'boss' || (form.platform === 'all' && form.includeBoss)) && Boolean(form.bossForwardMode) !== Boolean(form.bossForwardRecipient.trim())) return setValidationError('Boss 转发方式和收件人必须同时填写');
      body = { ...commonBody(form, mode), jobsFile: form.jobsFile.trim() };
    } else if (mode === 'talent-mapping') {
      if (!form.talentMappingFile.trim()) return setValidationError('Talent Mapping 计划文件必填');
      if (form.platform === 'boss') return setValidationError('Boss 不属于 Talent Mapping 产品范围');
      body = { platform: form.platform, talentMappingFile: form.talentMappingFile.trim(), mappingStage: 'scan' };
    } else if (mode === 'search-subscription') {
      if (!form.searchSubscriptionFile.trim()) return setValidationError('搜索订阅文件必填');
      body = {
        platform: form.platform,
        searchSubscriptionFile: form.searchSubscriptionFile.trim(),
        keyword: form.keyword.trim() || undefined,
        applicationFilterInputFile: form.applicationFilterInputFile.trim() || undefined,
        searchConditionSetRefs: refsForTargetPlatforms(form, mode),
        saveSearchSubscription: form.saveSearchSubscription,
        searchSubscriptionName: form.searchSubscriptionName.trim() || undefined,
      };
    } else if (mode === 'boss-auto-chat') {
      if (Boolean(form.bossForwardMode) !== Boolean(form.bossForwardRecipient.trim())) return setValidationError('Boss 转发方式和收件人必须同时填写');
      body = { platform: 'boss', scoreThreshold: Number(form.scoreThreshold), requireAllHardRequirements: form.requireAllHardRequirements, replyToUnqualifiedCandidates: form.replyToUnqualifiedCandidates, bossForwardMode: form.bossForwardMode || undefined, bossForwardRecipient: form.bossForwardRecipient.trim() || undefined, summaryEmail: form.summaryEmail.trim() || undefined, summaryCc: splitList(form.summaryCc), syncJobsBeforeReview: form.syncJobsBeforeReview };
    } else {
      body = { platform: form.platform };
    }
    mutation.mutate({ kind: mode, body });
  };

  return (
    <div className="page-stack">
      <PageHeader eyebrow="NEW TASK" title="新建任务" description="所有任务在服务端重新规范化后进入共享串行队列；页面预览不是执行来源。" />
      <Section>
        <div className="segmented">{([['resume-capture', '简历抓取'], ['batch', '批量任务'], ['talent-mapping', '人才地图扫描'], ['search-subscription', '搜索订阅'], ['boss-auto-chat', 'Boss 自动沟通'], ['login-refresh', '登录刷新']] as const).map(([value, label]) => <button type="button" className={mode === value ? 'active' : ''} key={value} onClick={() => setModeSafe(value)}>{label}</button>)}</div>
      </Section>
      <Section title="任务参数" description={mode === 'boss-auto-chat' ? 'Boss 是单平台独立模式。' : mode === 'talent-mapping' ? '此入口只执行卡片扫描；详情补全需在人才地图项目页核对精确人数并逐轮确认。' : '全部主平台默认运行 51job、猎聘和智联；普通抓取与批量可显式追加直猎邦。'}>
        <div className="form-grid">
          <label><span>平台</span><select value={form.platform} onChange={(event) => set('platform', event.target.value as PlatformSelection)} disabled={mode === 'boss-auto-chat'}>{(mode === 'boss-auto-chat' ? ['boss'] : mode === 'login-refresh' ? ['51job', 'liepin', 'zhilian', 'boss'] : mode === 'talent-mapping' ? ['51job', 'liepin', 'zhilian', 'all'] : ['51job', 'liepin', 'zhilian', 'boss', 'all']).map((item) => <option value={item} key={item}>{PLATFORM_LABELS[item as keyof typeof PLATFORM_LABELS]}</option>)}</select></label>
          {(mode === 'resume-capture' || mode === 'search-subscription') && <label><span>{showBossSavedJob ? '岗位名称' : '关键词'}</span><input value={form.keyword} onChange={(event) => set('keyword', event.target.value)} placeholder={showBossSavedJob ? '选择已同步 Boss 岗位，或输入新岗位名称' : '例如：Java 后端'} /></label>}
          {mode === 'batch' && <label><span>批量任务文件</span><input value={form.jobsFile} onChange={(event) => set('jobsFile', event.target.value)} placeholder="./jobs.json" /></label>}
          {mode === 'talent-mapping' && <><label className="wide"><span>Talent Mapping 计划文件</span><input value={form.talentMappingFile} onChange={(event) => set('talentMappingFile', event.target.value)} placeholder="./mapping/retail-operations.json" /></label><div className="security-note wide">计划文件必须显式设置批次、候选和详情上限。扫描不会写岗位、seen、评分、邮件或 RAG；完成扫描后从“人才地图”项目页发起详情补全。</div></>}
          {mode === 'search-subscription' && <><label><span>订阅文件</span><input value={form.searchSubscriptionFile} onChange={(event) => set('searchSubscriptionFile', event.target.value)} placeholder="./search-subscription.json" /></label><label><span>订阅名称</span><input value={form.searchSubscriptionName} onChange={(event) => set('searchSubscriptionName', event.target.value)} /></label><label className="checkbox-field"><input type="checkbox" checked={form.saveSearchSubscription} onChange={(event) => set('saveSearchSubscription', event.target.checked)} />保存平台订阅</label></>}
          {mode === 'resume-capture' && <><label className="wide"><span>JD 文本</span><textarea value={form.jd} onChange={(event) => set('jd', event.target.value)} rows={6} /></label><label><span>JD 文件</span><input value={form.jdFile} onChange={(event) => set('jdFile', event.target.value)} placeholder="./jd.txt" /></label></>}
          {showBossSavedJob && <><label className="wide"><span>Boss 已同步岗位</span>{bossPositionsQuery.isLoading ? <LoadingState label="读取 Boss 职位" /> : <select value={form.bossJobId} onChange={(event) => selectBossJob(event.target.value)}><option value="">不选择（按岗位名匹配或新建）</option>{bossPositionsQuery.data?.positions.filter((position) => Boolean(position.jobKey)).map((position) => <option key={position.bossJobId} value={position.bossJobId}>{position.name} · {position.status} · {position.bossJobId}</option>)}</select>}{bossPositionsQuery.error && <small className="inline-error">无法读取 Boss 已同步岗位：{bossPositionsQuery.error instanceof Error ? bossPositionsQuery.error.message : String(bossPositionsQuery.error)}</small>}</label><label><span>Boss 页面搜索词（可选覆盖）</span><input value={form.bossSearchKeyword} onChange={(event) => set('bossSearchKeyword', event.target.value)} placeholder="默认复用岗位设置或条件集默认关键词" /></label>{form.bossJobId && <div className="security-note wide">{selectedBossJobQuery.isLoading ? '正在读取岗位保存设置…' : selectedBossSearchSettings ? <>复用岗位设置：{selectedBossSearchSettings.source === 'direct' ? '直接搜索' : '已保存搜索'}{selectedBossSearchSettings.pageKeyword ? `；页面搜索词：${selectedBossSearchSettings.pageKeyword}` : savedBossDefaultKeyword ? `；条件集默认搜索词：${savedBossDefaultKeyword}` : '；页面搜索词将使用岗位名称'}{selectedBossSearchSettings.conditionSetRef ? `；已保存条件集：${selectedBossSearchSettings.conditionSetRef.conditionSetId}@${selectedBossSearchSettings.conditionSetRef.revision}` : '；未关联条件集'}。</> : '该职位尚无本地保存设置；请提供 JD 或显式配置搜索来源。'}</div>}</>}
          {(mode === 'resume-capture' || mode === 'batch') && <><label><span>搜索来源</span><select value={form.searchSource} onChange={(event) => set('searchSource', event.target.value as FormState['searchSource'])}><option value="">复用岗位设置</option><option value="saved">已保存搜索</option><option value="direct">直接搜索</option></select></label><label className="checkbox-field"><input type="checkbox" checked={form.includeViewed} onChange={(event) => set('includeViewed', event.target.checked)} />包含已查看候选人</label>{form.platform === 'all' && <label className="checkbox-field"><input type="checkbox" checked={form.includeBoss} onChange={(event) => set('includeBoss', event.target.checked)} />包含 Boss 直聘·直猎邦 Pro</label>}</>}
          {(mode === 'resume-capture' || mode === 'batch') && <><label><span>报告邮箱</span><input type="email" value={form.email} onChange={(event) => set('email', event.target.value)} /></label><label><span>抄送</span><input value={form.cc} onChange={(event) => set('cc', event.target.value)} placeholder="逗号分隔" /></label></>}
          {(form.platform === 'liepin' || form.platform === 'all') && (mode === 'resume-capture' || mode === 'batch') && <label><span>猎聘转发联系人</span><input value={form.liepinForwardContact} onChange={(event) => set('liepinForwardContact', event.target.value)} /></label>}
          {(form.platform === 'boss' || (form.platform === 'all' && form.includeBoss)) && (mode === 'resume-capture' || mode === 'batch' || mode === 'boss-auto-chat') && <><label><span>Boss 转发方式</span><select value={form.bossForwardMode} onChange={(event) => set('bossForwardMode', event.target.value as FormState['bossForwardMode'])}><option value="">不转发</option><option value="colleague">站内同事</option><option value="email">邮件</option></select></label><label><span>Boss 转发收件人</span><input value={form.bossForwardRecipient} onChange={(event) => set('bossForwardRecipient', event.target.value)} /></label></>}
          {form.platform === 'all' && form.includeBoss && (mode === 'resume-capture' || mode === 'batch') && <div className="security-note wide">直猎邦会作为第 4 个阶段运行并打开候选人详情；如该岗位已保存 Boss 转发配置，省略本次参数时可能复用该配置。深度搜索、打招呼、聊天和职位同步不会执行。</div>}
          {mode === 'boss-auto-chat' && <><label className="checkbox-field"><input type="checkbox" checked={form.requireAllHardRequirements} onChange={(event) => set('requireAllHardRequirements', event.target.checked)} />所有硬性要求必须满足</label>{!form.requireAllHardRequirements && <label><span>评分线</span><input type="number" min="0" max="100" value={form.scoreThreshold} onChange={(event) => set('scoreThreshold', event.target.value)} /></label>}<label className="checkbox-field"><input type="checkbox" checked={form.replyToUnqualifiedCandidates} onChange={(event) => set('replyToUnqualifiedCandidates', event.target.checked)} />回复不合适候选人</label><label className="checkbox-field"><input type="checkbox" checked={form.syncJobsBeforeReview} onChange={(event) => set('syncJobsBeforeReview', event.target.checked)} />审查前同步职位/JD</label><label><span>总结邮件</span><input type="email" value={form.summaryEmail} onChange={(event) => set('summaryEmail', event.target.value)} /></label><label><span>总结抄送</span><input value={form.summaryCc} onChange={(event) => set('summaryCc', event.target.value)} /></label></>}
        </div>
        <div className="form-actions"><button className="primary-button" type="button" disabled={mutation.isPending} onClick={submit}><Play size={16} />{mutation.isPending ? '提交中' : mode === 'talent-mapping' ? '提交扫描任务' : '提交任务'}</button></div>
      </Section>
      {showFilter && <Section title="搜索条件集" description="新流程直接引用平台条件集并固定 revision；不会生成或传递新的运行时筛选文件。">
        <div className="condition-set-selector-grid">{selectedPlatforms.map((platform) => <ConditionSetSelector key={platform} platform={platform} value={form.searchConditionSetRefs[platform]} onChange={(value) => setConditionSetReference(platform, value)} />)}</div>
        {form.platform === 'all' && <div className="security-note">“全部平台”必须为每个平台单独选择条件集；未设置的平台沿用其岗位设置或不带本次筛选，绝不会广播另一平台的条件。</div>}
        {hasReferences(form) && <div className="success-banner">已选择 {Object.keys(refsForTargetPlatforms(form, mode) ?? {}).length} 个平台条件集；提交时将固定其当前 revision。</div>}
        <details className="legacy-filter-details"><summary>使用旧筛选文件（兼容入口）</summary><p>仅用于已有文件迁移。填写后会清除本页条件集选择，新的条件集不使用文件路径。</p><label><span>旧筛选条件文件</span><input value={form.applicationFilterInputFile} onChange={(event) => setLegacyFilterFile(event.target.value)} placeholder="仅兼容既有 applicationFilterInputFile" /></label></details>
        {form.platform !== 'all' ? <FilterBuilder platform={form.platform} onSaved={(reference) => setConditionSetReference(reference.platform, reference)} title="新建并选用条件集" /> : <div className="security-note">可前往 <Link className="text-link" to="/search-condition-sets">搜索条件集</Link>，分别为各平台创建条件集后返回选择。</div>}
      </Section>}
      {validationError && <ErrorState error={new Error(validationError)} />}{mutation.error && <ErrorState error={mutation.error} />}
      {mutation.data && <SuccessNotice><CheckCircle2 size={18} />任务已创建：<Link className="text-link" to={`/tasks/${encodeURIComponent(mutation.data.taskId)}`}>{mutation.data.taskId}</Link></SuccessNotice>}
    </div>
  );
}

function splitList(value: string): string[] | undefined {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function commonBody(form: FormState, mode: 'resume-capture' | 'batch'): Record<string, unknown> {
  const searchConditionSetRefs = form.searchSource === 'direct' ? refsForTargetPlatforms(form, mode) : undefined;
  return {
    platform: form.platform,
    includeBoss: form.platform === 'all' ? form.includeBoss : undefined,
    includeViewed: form.includeViewed,
    searchSource: form.searchSource || undefined,
    applicationFilterInputFile: form.searchSource === 'direct' && !searchConditionSetRefs ? form.applicationFilterInputFile.trim() || undefined : undefined,
    searchConditionSetRefs,
    email: form.email.trim() || undefined,
    cc: splitList(form.cc),
    liepinForwardContact: form.platform === 'liepin' || form.platform === 'all' ? form.liepinForwardContact.trim() || undefined : undefined,
    bossJobId: mode === 'resume-capture' && (form.platform === 'boss' || (form.platform === 'all' && form.includeBoss)) ? form.bossJobId || undefined : undefined,
    bossSearchKeyword: mode === 'resume-capture' && (form.platform === 'boss' || (form.platform === 'all' && form.includeBoss)) ? form.bossSearchKeyword.trim() || undefined : undefined,
    bossForwardMode: form.platform === 'boss' || (form.platform === 'all' && form.includeBoss) ? form.bossForwardMode || undefined : undefined,
    bossForwardRecipient: form.platform === 'boss' || (form.platform === 'all' && form.includeBoss) ? form.bossForwardRecipient.trim() || undefined : undefined,
  };
}
