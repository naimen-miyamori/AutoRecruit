import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Copy, Plus, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Platform, SearchConditionSetCompatibility, SearchConditionSetRef, SearchConditionSetRevision, SearchConditionSetStatus } from '../../api/contracts';
import { ApiRequestError, api, queryKeys } from '../../api/client';
import { SafetyDialog } from '../../components/SafetyDialog';
import { EmptyState, ErrorState, IconButton, JsonViewer, LoadingState, PageHeader, PLATFORM_LABELS, Section, StatusPill, SuccessNotice } from '../../components/ui';
import { FilterBuilder, type FilterBuilderInitialValue } from '../run/FilterBuilder';

const PLATFORMS: Platform[] = ['51job', 'liepin', 'zhilian', 'boss'];

function compatibilityTone(compatibility?: SearchConditionSetCompatibility): 'ok' | 'warning' | 'failed' | 'neutral' {
  if (compatibility?.status === 'compatible') return 'ok';
  if (compatibility?.status === 'drifted') return 'warning';
  if (compatibility?.status === 'incompatible') return 'failed';
  return 'neutral';
}

function compatibilityLabel(compatibility?: SearchConditionSetCompatibility): string {
  if (compatibility?.status === 'compatible') return '目录兼容';
  if (compatibility?.status === 'drifted') return '目录有变化';
  if (compatibility?.status === 'incompatible') return '目录不兼容';
  return '未检查';
}

function asInitialValue(revision: SearchConditionSetRevision): FilterBuilderInitialValue {
  return {
    conditionSetId: revision.conditionSetId,
    expectedRevision: revision.revision,
    name: revision.name,
    description: revision.description,
    defaultKeyword: revision.defaultKeyword,
    applicationFilterInput: revision.applicationFilterInput,
  };
}

function conflictMessage(error: unknown): string | undefined {
  return error instanceof ApiRequestError && error.status === 409
    ? '该条件集刚刚被其他操作更新，请刷新详情、比较最新 revision 后再提交。'
    : undefined;
}

export function SearchConditionSetsPage() {
  const [platform, setPlatform] = useState<Platform>('51job');
  const [status, setStatus] = useState<SearchConditionSetStatus | 'all'>('active');
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: queryKeys.searchConditionSets(platform, status),
    queryFn: ({ signal }) => api.listSearchConditionSets(platform, status, signal),
  });
  const conditionSets = listQuery.data?.conditionSets ?? [];
  const effectiveSelectedId = selectedId && conditionSets.some((item) => item.conditionSetId === selectedId)
    ? selectedId
    : conditionSets[0]?.conditionSetId;
  const detailQuery = useQuery({
    queryKey: queryKeys.searchConditionSet(effectiveSelectedId ?? ''),
    queryFn: ({ signal }) => api.getSearchConditionSet(effectiveSelectedId!, signal),
    enabled: Boolean(effectiveSelectedId),
  });
  const detail = detailQuery.data;
  const conflict = conflictMessage(detailQuery.error);
  const refresh = () => void Promise.all([listQuery.refetch(), detailQuery.refetch()]);
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['search-condition-sets'] });
  };
  const cloneMutation = useMutation({
    mutationFn: () => api.cloneSearchConditionSet(detail!.conditionSet.conditionSetId, {
      name: cloneName.trim() || `${detail!.conditionSet.name} 副本`,
    }),
    onSuccess: async (result) => {
      setCloneName('');
      setCreating(false);
      setSelectedId(result.conditionSet.conditionSetId);
      await invalidate();
    },
  });
  const archiveMutation = useMutation({
    mutationFn: () => api.archiveSearchConditionSet(detail!.conditionSet.conditionSetId, detail!.conditionSet.revision),
    onSuccess: async () => {
      setCreating(false);
      await invalidate();
      await detailQuery.refetch();
    },
  });
  const selectedRevision = useMemo(() => detail?.revisions.find((item) => item.revision === detail.conditionSet.revision) ?? detail?.conditionSet, [detail]);
  const isArchived = detail?.conditionSet.status === 'archived';
  const conditionSetSaved = async (reference: SearchConditionSetRef) => {
    setCreating(false);
    setSelectedId(reference.conditionSetId);
    await invalidate();
  };

  return (
    <div className="page-stack">
      <PageHeader eyebrow="SEARCH CONDITION SETS" title="搜索条件集" description="命名条件集独立于岗位；选择时固定 revision，后续编辑不会改写已入队任务或岗位快照。" actions={<IconButton label="刷新条件集" onClick={refresh}><RefreshCw size={17} /></IconButton>} />
      <Section title="平台与状态" description="条件集不能跨平台复用；目录漂移由服务端在保存和执行前复核。" actions={<button className="primary-button" type="button" onClick={() => { setCreating(true); setSelectedId(undefined); }}><Plus size={16} />新建条件集</button>}>
        <div className="toolbar">
          <div className="toolbar-group">
            <label><span>平台</span><select value={platform} onChange={(event) => { setPlatform(event.target.value as Platform); setSelectedId(undefined); setCreating(false); }}>{PLATFORMS.map((item) => <option key={item} value={item}>{PLATFORM_LABELS[item]}</option>)}</select></label>
            <label><span>状态</span><select value={status} onChange={(event) => { setStatus(event.target.value as SearchConditionSetStatus | 'all'); setSelectedId(undefined); }}><option value="active">可用</option><option value="archived">已归档</option><option value="all">全部</option></select></label>
          </div>
          <span className="mono">{conditionSets.length} 个条件集</span>
        </div>
      </Section>
      {listQuery.error && <ErrorState error={listQuery.error} onRetry={refresh} />}
      <div className="split-layout">
        <Section title="条件集列表">
          {listQuery.isLoading && <LoadingState label="读取条件集" />}
          {!listQuery.isLoading && conditionSets.length === 0 && <EmptyState title="尚无条件集" description="新建后可在新任务中按平台选择并固定版本。" />}
          <div className="condition-set-list">
            {conditionSets.map((item) => <button className={`condition-set-row${item.conditionSetId === effectiveSelectedId ? ' selected' : ''}`} type="button" key={item.conditionSetId} onClick={() => { setSelectedId(item.conditionSetId); setCreating(false); }}>
              <div><strong>{item.name}</strong><small>revision {item.revision} · {item.fieldCount} 个字段{item.defaultKeyword ? ` · 默认关键词：${item.defaultKeyword}` : ''}</small></div>
              <div className="condition-set-row-meta"><StatusPill status={item.status === 'active' ? 'ok' : 'neutral'} label={item.status === 'active' ? '可用' : '已归档'} /><StatusPill status={compatibilityTone(item.compatibility)} label={compatibilityLabel(item.compatibility)} /></div>
            </button>)}
          </div>
        </Section>
        <div className="page-stack">
          {creating && <FilterBuilder platform={platform} onSaved={(reference) => { void conditionSetSaved(reference); }} title={`新建 ${PLATFORM_LABELS[platform]} 条件集`} />}
          {!creating && !effectiveSelectedId && <Section title="条件集详情"><EmptyState title="请选择或新建一个条件集" /></Section>}
          {!creating && effectiveSelectedId && detailQuery.isLoading && <Section title="条件集详情"><LoadingState label="读取条件集详情" /></Section>}
          {!creating && effectiveSelectedId && detailQuery.error && <Section title="条件集详情"><ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />{conflict && <div className="stale-banner"><span>{conflict}</span></div>}</Section>}
          {!creating && detail && <>
            <Section title={detail.conditionSet.name} description={detail.conditionSet.description || '未填写说明。'} actions={<div className="page-actions"><StatusPill status={detail.conditionSet.status === 'active' ? 'ok' : 'neutral'} label={detail.conditionSet.status === 'active' ? '可用' : '已归档'} /><StatusPill status={compatibilityTone(detail.compatibility)} label={compatibilityLabel(detail.compatibility)} /></div>}>
              {detail.compatibility.status !== 'compatible' && <div className={detail.compatibility.status === 'incompatible' ? 'error-banner' : 'stale-banner'} role={detail.compatibility.status === 'incompatible' ? 'alert' : undefined}><span>{detail.compatibility.message ?? '尚未取得当前筛选目录兼容性结果。'}</span></div>}
              <div className="detail-grid">
                <div className="detail-cell"><span>条件集 ID</span><strong className="mono">{detail.conditionSet.conditionSetId}</strong></div>
                <div className="detail-cell"><span>当前 revision</span><strong>{detail.conditionSet.revision}</strong></div>
                <div className="detail-cell"><span>默认关键词</span><strong>{detail.conditionSet.defaultKeyword || '-'}</strong></div>
                <div className="detail-cell"><span>选中字段</span><strong>{detail.conditionSet.fieldCount}</strong></div>
              </div>
              <div className="form-grid condition-set-actions">
                <label><span>克隆名称</span><input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder={`${detail.conditionSet.name} 副本`} /></label>
                <div className="form-actions"><button className="secondary-button" type="button" disabled={cloneMutation.isPending} onClick={() => cloneMutation.mutate()}><Copy size={15} />{cloneMutation.isPending ? '克隆中' : '克隆为新条件集'}</button>{!isArchived && <SafetyDialog trigger={<button className="danger-button" type="button" disabled={archiveMutation.isPending}><Archive size={15} />归档</button>} title="归档搜索条件集" description="归档会阻止新任务或新调度轮次引用该条件集；已固定 revision 的历史任务不会被修改，也不会打开浏览器。" facts={[{ label: '名称', value: detail.conditionSet.name }, { label: '平台', value: PLATFORM_LABELS[detail.conditionSet.platform] }, { label: '当前版本', value: `revision ${detail.conditionSet.revision}` }]} confirmLabel="确认归档" busy={archiveMutation.isPending} onConfirm={() => archiveMutation.mutate()} />}</div>
              </div>
              {cloneMutation.error && <ErrorState error={cloneMutation.error} />}
              {archiveMutation.error && <ErrorState error={archiveMutation.error} />}
            </Section>
            {!isArchived && selectedRevision && <FilterBuilder platform={detail.conditionSet.platform} initialValue={asInitialValue(selectedRevision)} onSaved={(reference) => { void conditionSetSaved(reference); }} title="编辑当前条件集" />}
            <Section title="revision 历史" description="每次编辑、重命名或归档都会创建不可变 revision。">
              <div className="table-wrap"><table><thead><tr><th>版本</th><th>状态</th><th>字段</th><th>默认关键词</th><th>更新时间</th><th>目录证据</th></tr></thead><tbody>{detail.revisions.map((item) => <tr key={item.revision}><td>revision {item.revision}</td><td><StatusPill status={item.status === 'active' ? 'ok' : 'neutral'} label={item.status === 'active' ? '可用' : '已归档'} /></td><td>{item.fieldCount}</td><td>{item.defaultKeyword || '-'}</td><td>{item.updatedAt}</td><td className="mono">{item.catalogEvidence?.selectedFieldsFingerprint ?? '-'}</td></tr>)}</tbody></table></div>
              {selectedRevision && <details className="condition-set-json"><summary>查看当前 revision 的规范化输入</summary><JsonViewer value={selectedRevision.applicationFilterInput} /></details>}
            </Section>
            {cloneMutation.data && <SuccessNotice>已克隆为 {cloneMutation.data.conditionSet.name} · revision {cloneMutation.data.conditionSet.revision}</SuccessNotice>}
          </>}
        </div>
      </div>
    </div>
  );
}
