/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
(() => {
  const stages = ['桌面与 IPC','等待帧 / begin','定位头姿','输入与图集准备','获取交换链','录制 / 提交 / 等待','释放交换链','EndFrame 与状态更新'];
  const inputNames = ['动作与路由','动画 / 栅格化','几何上传','射线反馈'];
  const renderNames = ['复用 fence / begin','彩透准备 / 位姿','录制图集上传','左眼录制','右眼录制','额外图层录制','结束命令缓冲','queueSubmit','等待完成 fence','查询 / 读回 / 释放上传'];
  const preNames = ['头姿与控制更新','手关节定位','手部网格更新'];
  const gpuNames = ['上传','左眼','右眼','额外图层'];
  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const ms = (a,b) => (b-a)/1e6;
  const fmt = v => finite(v) ? v.toFixed(3) : '—';
  const validTimes = (v,n) => Array.isArray(v) && v.length === n && v.every((x,i) => finite(x) && x > 0 && (!i || x >= v[i-1]));
  let recording = null, all = [], frames = [], system = [], metadata = null, index = 0, source = '', positions = new Map(), kernel = [], kernelErrors = 0;
  const element = (tag, text, className) => { const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e; };
  const quantile = (a,p) => { const v=a.filter(finite).sort((a,b)=>a-b);return v.length?v[Math.floor((v.length-1)*p)]:null; };
  function load(data, label='timeline.json') {
    const candidate=data.samples || data.timeline?.frames || data.frames;
    if(!Array.isArray(candidate) || candidate.length > 200000) throw Error('需要 timeline samples 或 summary.timeline.frames（最多 200000 帧）');
    const checked=candidate.filter(f=>validTimes(f.mono_ns,9) && Number.isSafeInteger(f.number));
    if(!checked.length) throw Error('没有有效的逐帧 CLOCK_MONOTONIC 边界');
    for(let i=1;i<checked.length;i++) if(checked[i].number<=checked[i-1].number || checked[i].mono_ns[0]<checked[i-1].mono_ns[8]) throw Error('帧号/时间重叠或回退，请分开不同会话');
    recording=data;all=checked;source=label;positions=new Map(all.map((f,i)=>[f,i]));
    $('status').textContent=`${label} · ${checked.length} 帧 · 丢弃无效记录 ${candidate.length-checked.length} · 历史/导入记录，非实时采样`;
    $('export').disabled=false;refresh();
  }
  function summary() { return recording?.summary || recording?.timeline || {}; }
  function groups(f) {
    const list=[['主线程',stages,f.mono_ns]];
    if(validTimes(f.pre_input_mono_ns,4))list.push(['头姿与手部',preNames,f.pre_input_mono_ns]);
    if(validTimes(f.input_mono_ns,5))list.push(['输入 / UI',inputNames,f.input_mono_ns]);
    if(validTimes(f.render_mono_ns,11))list.push(['绘制细分',renderNames,f.render_mono_ns]);
    if(validTimes(f.end_frame_mono_ns,3))list.push(['提交后处理',['图层 / EndFrame','状态遥测更新'],f.end_frame_mono_ns]);
    return list;
  }
  function slices(f) {
    const result=[];
    groups(f).forEach(([track,names,times])=>names.forEach((name,i)=>result.push({track,name,start:times[i],end:times[i+1]})));
    [['动作同步',f.action_sync_span],['左手状态读取',f.controller_read_spans?.[0]],['右手状态读取',f.controller_read_spans?.[1]]].forEach(([name,t])=>{if(validTimes(t,2))result.push({track:'动作读取',name,start:t[0],end:t[1]});});
    [['输入取姿态',f.input_view_locate_mono_ns],['绘制前取姿态',f.render_view_locate_mono_ns]].forEach(([name,t])=>{if(validTimes(t,2))result.push({track:'头姿定位',name,start:t[0],end:t[1]});});
    (f.draw_spans || []).forEach(s=>{if(validTimes(s.mono_ns,2))result.push({track:'模型与面板录制',name:`${s.eye?'右':'左'} ${s.pass} / ${s.stage}`,start:s.mono_ns[0],end:s.mono_ns[1]});});
    if(validTimes(f.loop_mono_ns,3))['帧前事件处理','采样请求检查 / 导出'].forEach((name,i)=>result.push({track:'帧外工作',name,start:f.loop_mono_ns[i],end:f.loop_mono_ns[i+1]}));
    if(f.post_frame_complete && validTimes(f.post_frame_mono_ns,2))result.push({track:'帧外工作',name:'记录 / 截图文件 / 日志',start:f.post_frame_mono_ns[0],end:f.post_frame_mono_ns[1]});
    return result;
  }
  function interval(f) {
    const i=positions.get(f), next=all[i+1];
    return next && next.number===f.number+1 && (!f.wait_number || next.wait_number===f.wait_number+1) ? ms(f.mono_ns[0],next.mono_ns[0]) : null;
  }
  function refresh() {
    frames=all.filter(f=>($('captures').checked || !f.capture) && ($('mask').value==='all' || f.controller_draw_mask===Number($('mask').value)));
    index=Math.min(index,Math.max(0,frames.length-1));$('frame').max=Math.max(0,frames.length-1);
    const duration=frames.map(f=>ms(f.mono_ns[0],f.mono_ns[8]));
    const intervals=frames.map(interval).filter(finite);
    const hz=Number($('hz').value), budget=1000/(hz>0?hz:72);
    $('kpis').replaceChildren();
    [['有效分析帧',frames.length,`筛选排除 ${all.length-frames.length} 帧`],['帧墙钟 P95',`${fmt(quantile(duration,.95))} ms`,'包含等待与被抢占'],['间隔 P99',`${fmt(quantile(intervals,.99))} ms`,'仅相邻连续帧；非物理扫描'],['间隔超参考预算',`${intervals.filter(v=>v>budget).length} / ${intervals.length}`,`参考 ${fmt(budget)} ms`]].forEach(([label,value,note])=>{const e=element('div',undefined,'kpi');e.append(element('span',label),element('b',value),element('small',note));$('kpis').append(e);});
    const stageValues=new Map();
    frames.forEach(f=>groups(f).forEach(([track,names,times])=>names.forEach((name,i)=>{const key=track+' / '+name;if(!stageValues.has(key))stageValues.set(key,[]);stageValues.get(key).push(ms(times[i],times[i+1]));})));
    $('stages').replaceChildren();stageValues.forEach((v,name)=>{const row=element('tr');row.append(element('td',name));[.5,.95,.99,1].forEach(p=>row.append(element('td',fmt(quantile(v,p)))));$('stages').append(row);});
    const head=frames.filter(f=>(f.head_flags&15)===15).length;
    const left=frames.filter(f=>f.controller_grip?.[0]).length,right=frames.filter(f=>f.controller_grip?.[1]).length;
    const atlasFrames=frames.filter(f=>Array.isArray(f.atlas_update));
    const messages=[`头部 valid + tracked：${head}/${frames.length}；原始 flags 随帧保留。`,`左右手柄可用 grip：${left} / ${right} 帧；有位姿不等于 tracked，按帧查看原始 flags。`,atlasFrames.length?`图集已采样 ${atlasFrames.length}/${frames.length} 帧；上传 ${atlasFrames.filter(f=>f.atlas_update[1]>0).length} 帧，全量替换 ${atlasFrames.filter(f=>f.atlas_update[2]).length} 帧。`:"图集上传计数未提供。",`未渲染记录：${summary().skipped ? summary().skipped.length : '未提供'} 条；旧记录未提供时不推断为零。`];
    if(!left || !right)messages.push('双手柄移动/模型性能验收缺少有效样本，不能由此证明没有手柄瓶颈。');
    $('health').replaceChildren(...messages.map(v=>element('p',v)));
    $('coverage').textContent=`CPU 主阶段已提供；绘制细分 ${frames.filter(f=>validTimes(f.render_mono_ns,11)).length} 帧；GPU 查询 ${frames.filter(f=>f.gpu?.intervals_ns).length} 帧；线程 CPU 时间 ${frames.filter(f=>validTimes(f.thread_cpu_ns,2)).length} 帧。系统采样 ${system.length} 条。`;
    select(index);
  }
  function plot() {
    const c=$('overview'),ctx=c.getContext('2d'),w=c.clientWidth,h=220,dpr=window.devicePixelRatio||1;
    c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
    if(!frames.length)return;
    const values=frames.map(f=>ms(f.mono_ns[0],f.mono_ns[8])), spans=frames.map(interval);
    const budget=1000/(Number($('hz').value)||72),max=values.concat(spans.filter(finite)).reduce((a,b)=>Math.max(a,b),budget*1.5);
    const y=v=>h-25-v/max*(h-45), step=(w-60)/frames.length;
    ctx.font='11px system-ui';ctx.fillStyle='#a6b7ca';ctx.strokeStyle='#576579';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(45,y(budget));ctx.lineTo(w,y(budget));ctx.stroke();ctx.setLineDash([]);ctx.fillText(`${budget.toFixed(2)} ms`,0,y(budget)-5);
    values.forEach((v,i)=>{ctx.fillStyle=i===index?'#f1c48c':'#557b9c';ctx.fillRect(45+i*step,y(v),Math.max(1,step-.5),h-25-y(v));});
    ctx.strokeStyle='#8bd4ed';ctx.beginPath();let pen=false;spans.forEach((v,i)=>{if(!finite(v)){pen=false;return;}if(pen)ctx.lineTo(45+i*step,y(v));else ctx.moveTo(45+i*step,y(v));pen=true;});ctx.stroke();ctx.fillStyle='#b0bfd0';ctx.fillText(`帧 ${frames[0].number} → ${frames.at(-1).number} · 上界 ${max.toFixed(1)} ms`,45,h-5);
  }
  function select(i) {
    index=Math.max(0,Math.min(i,frames.length-1));$('frame').value=index;plot();
    const f=frames[index];$('lanes').replaceChildren();$('gpu').replaceChildren();$('selection').replaceChildren();if(!f){$('frame-title').textContent='无匹配帧';$('system-detail').replaceChildren();return;}
    $('frame-title').textContent=`帧 #${f.number} · ${fmt(ms(f.mono_ns[0],f.mono_ns[8]))} ms`;
    const tags=[`头姿 flags ${f.head_flags}`,`grip 左/右 ${f.controller_grip?.map(Boolean).join(' / ')}`,`位姿标志 grip/aim ${JSON.stringify(f.controller_flags??'未提供')}`,`图集 ${f.atlas_update?.[1]??'—'} bytes`,`图层 ${f.layers}`,`模型配置 mask ${f.controller_draw_mask}`,`空间快速路径 ${f.spatial_fast_path??"未提供"}`,`截图 ${!!f.capture}`];
    if(validTimes(f.thread_cpu_ns,2))tags.push(`线程实际 CPU ${fmt(ms(...f.thread_cpu_ns))} ms`,`核 ${f.cpu_core?.join(' → ')}`);
    if(f.model_vertices)tags.push(`控制器/手模型顶点 ${JSON.stringify(f.model_vertices)}`,`面板实例 ${f.panel_instances}`);
    if(f.runtime_now_xr_ns && validTimes(f.runtime_now_mono_bracket_ns,2))tags.push(`预测显示提前量（配对时刻）${fmt(ms(f.runtime_now_xr_ns,f.predicted_display_xr_ns))} ms`);
    if(f.render_runtime_now_xr_ns && validTimes(f.render_runtime_now_mono_bracket_ns,2))tags.push(`绘制前剩余预测窗口（配对时刻）${fmt(ms(f.render_runtime_now_xr_ns,f.predicted_display_xr_ns))} ms`);
    if(validTimes(f.input_view_locate_mono_ns,2) && validTimes(f.render_view_locate_mono_ns,2))tags.push(`两次取姿态间隔 ${fmt(ms(f.input_view_locate_mono_ns[1],f.render_view_locate_mono_ns[0]))} ms（不等同于传感器新鲜度改善）`);
    const previous=all[positions.get(f)-1];
    if(previous && previous.number+1===f.number && f.predicted_display_xr_ns>previous.predicted_display_xr_ns) {
      function delta(a,b) {if(!Array.isArray(a)||!Array.isArray(b)||a.length!==7||b.length!==7||!a.every(finite)||!b.every(finite))return '缺少连续有效样本';const d=Math.hypot(...a.slice(0,3).map((v,i)=>v-b[i]))*1000;const an=Math.hypot(...a.slice(3)),bn=Math.hypot(...b.slice(3));if(!an||!bn)return '四元数无效';const dot=Math.abs(a.slice(3).reduce((v,x,i)=>v+x*b[i+3],0)/(an*bn));return `${d.toFixed(2)} mm / ${(2*Math.acos(Math.min(1,dot))*180/Math.PI).toFixed(2)}°`;}
      if((f.head_flags&15)===15 && (previous.head_flags&15)===15)tags.push('相邻头姿变化 '+delta(f.head_pose,previous.head_pose));
      for(let h=0;h<2;h++)tags.push(`${h?'右':'左'}手柄相邻位姿变化 `+delta(f.controller_grip?.[h],previous.controller_grip?.[h]));
    }
    $('selection').append(...tags.map(t=>element('span',t,'pill')));
    const byTrack=new Map();slices(f).forEach(s=>{if(!byTrack.has(s.track))byTrack.set(s.track,[]);byTrack.get(s.track).push(s);});
    const left=validTimes(f.loop_mono_ns,3)?f.loop_mono_ns[0]:f.mono_ns[0];
    const right=f.post_frame_complete?f.post_frame_mono_ns[1]:f.mono_ns[8];
    const total=right-left;
    byTrack.forEach((items,name)=>{const row=element('div',undefined,'track'),strip=element('div',undefined,'strip');row.append(element('span',name),strip);items.forEach(s=>{const e=element('span',s.name,'slice');e.style.left=(s.start-left)/total*100+'%';e.style.width=(s.end-s.start)/total*100+'%';e.title=`${s.name}\n开始 +${fmt(ms(f.mono_ns[0],s.start))} ms\n耗时 ${fmt(ms(s.start,s.end))} ms`;strip.append(e);});$('lanes').append(row);});
    const g=f.gpu?.intervals_ns;
    $('gpu').append(element('b','GPU 设备时钟 · 独立耗时轨道'),element('p',g?gpuNames.map((n,i)=>`${n} ${fmt(g[i]/1e6)} ms`).join(' / '):`未提供（${f.gpu?.status || '旧采样没有 GPU 查询'}）`));
    showSystem(f);
  }
  function showSystem(f) {
    const holder=$('system-detail');holder.replaceChildren();if(!system.length && !kernel.length)return;
    if(metadata?.clock!=='CLOCK_MONOTONIC' || !metadata?.boot_id || !summary().boot_id || metadata.boot_id!==summary().boot_id){holder.append(element('p','系统记录尚未校验同一 boot；导入匹配 capture.json 与新版 timeline 后才按时间关联。','warning'));return;}
    const t=f.mono_ns[0];
    const alignedKernel=metadata.trace?.clock?.includes('[mono]')?kernel:[];
    const active=alignedKernel.filter(s=>s.start<f.mono_ns[8] && s.end>t);
    if(kernel.length && !alignedKernel.length)holder.append(element('p','调度 trace 时钟未确认是 mono，暂不关联。','warning'));
    if(alignedKernel.length){holder.append(element('p',`调度区间 ${active.length} 条与此帧相交；配对不一致 ${kernelErrors}。运行区间可能包含中断，不能视为纯函数执行时间。`));const list=element('ul');active.slice(0,20).forEach(s=>list.append(element('li',`CPU ${s.cpu} · ${s.name} [${s.tid}] · 与本帧重叠 ${fmt(ms(Math.max(s.start,t),Math.min(s.end,f.mono_ns[8])))} ms`)));holder.append(list);}
    if(metadata.trace)holder.append(element('p',`trace 丢失/覆盖统计保留在 capture.json；缓冲数 ${Object.keys(metadata.trace.buffers||{}).length}，不可当作全程无损。`));
    if(!system.length)return;
    const nearest=system.reduce((a,b)=>Math.abs(a.mono_ns-t)<Math.abs(b.mono_ns-t)?a:b);
    const age=Math.abs(nearest.mono_ns-t)/1e6;
    if(age>Math.max(250,(metadata.interval_ms||100)*2)){holder.append(element('p','所选帧不在系统采样覆盖窗口。'));return;}
    holder.append(element('p',`最近系统采样相距 ${fmt(age)} ms；读取跨度 ${fmt(ms(nearest.mono_ns,nearest.read_complete_ns))} ms（非原子快照）`));
    const cpu=nearest.proc?.['pressure/cpu'];if(cpu)holder.append(element('p','CPU 压力：'+cpu));
    const ul=element('ul');(nearest.threads||[]).slice(0,40).forEach(t=>ul.append(element('li',`${t.comm} [${t.tid}] CPU ${t.cpu} ${t.state} · schedstat ${t.schedstat||'缺失'}`)));holder.append(ul);
  }
  function trace() {
    const events=[],pid=summary().process_id||1;
    const tracks=new Map();let nextTid=1;
    function tid(name){if(!tracks.has(name)){tracks.set(name,nextTid++);events.push({ph:'M',name:'thread_name',pid,tid:tracks.get(name),args:{name}});}return tracks.get(name);}
    events.push({ph:'M',name:'process_name',pid,tid:0,args:{name:'xr-shell imported observations'}});
    frames.forEach(f=>{
      slices(f).forEach(s=>events.push({ph:'X',cat:'xr.cpu_wall',name:s.name,pid,tid:tid(s.track),ts:s.start/1000,dur:(s.end-s.start)/1000,args:{frame:f.number,capture:!!f.capture}}));
      events.push({ph:'C',cat:'xr.state',name:'frame state',pid,tid:tid('状态'),ts:f.mono_ns[0]/1000,args:{frame:f.number,head_flags:f.head_flags,left_grip:f.controller_grip?.[0]?1:0,right_grip:f.controller_grip?.[1]?1:0,...(f.atlas_update ? {atlas_bytes:f.atlas_update[1]} : {})}});
      if(f.gpu?.intervals_ns)events.push({ph:'C',cat:'xr.gpu_duration',name:'GPU durations (ms), sampled after fence',pid,tid:tid('GPU 耗时计数'),ts:f.mono_ns[8]/1000,args:Object.fromEntries(gpuNames.map((n,i)=>[n,f.gpu.intervals_ns[i]/1e6]))});
    });
    (summary().skipped||[]).forEach(s=>{if(validTimes(s.mono_ns,3))events.push({ph:'X',cat:'xr.skipped',name:s.reason,pid,tid:tid('未渲染'),ts:s.mono_ns[0]/1000,dur:(s.mono_ns[2]-s.mono_ns[0])/1000,args:{wait_number:s.wait_number}});});
    if(metadata?.clock==='CLOCK_MONOTONIC' && metadata?.boot_id && metadata.boot_id===summary().boot_id) {
      const cpus=new Set();
      (metadata.trace?.clock?.includes('[mono]')?kernel:[]).forEach(s=>{if(!cpus.has(s.cpu)){cpus.add(s.cpu);events.push({ph:'M',name:'thread_name',pid:2147483646,tid:s.cpu,args:{name:'CPU '+s.cpu+' scheduled (includes IRQ)'}});}events.push({ph:'X',cat:'sched',name:s.name,pid:2147483646,tid:s.cpu,ts:s.start/1000,dur:(s.end-s.start)/1000,args:{linux_tid:s.tid}});});
      system.forEach(s=>Object.entries(s.sensors||{}).forEach(([name,value])=>{if(value!==null && value!=='' && finite(Number(value)))events.push({ph:'C',cat:'system',name,pid:2147483645,tid:0,ts:s.mono_ns/1000,args:{value:Number(value)}});}));
    }
    return {traceEvents:events,displayTimeUnit:'ms',metadata:{clock:'CLOCK_MONOTONIC',boot_id:summary().boot_id||null,source,scope:'CPU wall time; GPU durations are counters, not aligned execution slices; synthetic track IDs are not Linux TIDs'}};
  }

  function loadKernel(text) {
    const running=new Map(), result=[];let errors=0;
    for(const line of text.split('\n')) {
      const match=line.match(/\[(\d+)\].*?\s(\d+\.\d+):\s+sched_switch:\s+prev_comm=(.*?) prev_pid=(\d+).*?==> next_comm=(.*?) next_pid=(\d+)/);
      if(!match)continue;
      const cpu=Number(match[1]), now=Number(match[2])*1e9, previous=running.get(cpu);
      if(previous) {
        if(previous.tid===Number(match[4]) && now>=previous.start)result.push({...previous,cpu,end:now});else errors++;
      }
      running.set(cpu,{tid:Number(match[6]),name:match[5],start:now});
    }
    kernel=result;kernelErrors=errors;
  }
  async function fileJSON(input) {const f=input.files[0];if(!f)return null;if(f.size>128*1024*1024)throw Error('文件超过 128 MiB，请缩短采样');return [JSON.parse(await f.text()),f.name];}
  function fail(e){$('status').textContent='导入失败：'+e.message;}
  $('file').onchange=async()=>{try{const r=await fileJSON($('file'));if(r)load(...r);}catch(e){fail(e);}};
  $('kernel').onchange=async()=>{try{const f=$('kernel').files[0];if(!f)return;if(f.size>128*1024*1024)throw Error('trace 超过 128 MiB');loadKernel(await f.text());refresh();}catch(e){fail(e);}};
  $('metadata').onchange=async()=>{try{const r=await fileJSON($('metadata'));if(r){metadata=r[0];refresh();}}catch(e){fail(e);}};
  $('system').onchange=async()=>{try{const f=$('system').files[0];if(!f)return;if(f.size>128*1024*1024)throw Error('系统文件超过 128 MiB');system=(await f.text()).trim().split('\n').filter(Boolean).map(JSON.parse).filter(s=>finite(s.mono_ns));refresh();}catch(e){fail(e);}};
  $('frame').oninput=e=>select(Number(e.target.value));$('previous').onclick=()=>select(index-1);$('next').onclick=()=>select(index+1);
  $('worst').onclick=()=>{if(frames.length)select(frames.reduce((best,f,i)=>ms(f.mono_ns[0],f.mono_ns[8])>ms(frames[best].mono_ns[0],frames[best].mono_ns[8])?i:best,0));};
  $('overview').onclick=e=>select(Math.floor((e.offsetX-45)/($('overview').clientWidth-60)*frames.length));
  $('captures').onchange=refresh;$('mask').onchange=refresh;$('hz').onchange=refresh;window.addEventListener('resize',plot);
  $('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(trace())],{type:'application/json'}));const a=element('a');a.href=url;a.download='xr-frame-trace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  window.xrPerf={load,trace,loadKernel};
  if(window.XR_FRAME_RECORDING)load(window.XR_FRAME_RECORDING,'历史实机样本 · 隔离记录');
})();
