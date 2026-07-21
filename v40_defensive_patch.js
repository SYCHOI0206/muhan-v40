(function(){
  'use strict';
  if (!window.V40DefensiveCore) {
    console.error('V40DefensiveCore가 로드되지 않았습니다.');
    return;
  }

  const Core = window.V40DefensiveCore;
  window.__V40_DEFENSIVE_PATCH_ACTIVE__ = true;
  window.__V40_DEFENSIVE_PATCH_VERSION__ = 'v8-reference-ui-manual-qty';
  const ACTION_CRASH = 'CRASH_FOLLOWUP_BUY';
  window.__v40ManualChoice = false;

  function priorValues(prior){
    return (prior || []).map(x => Number(x && x.close != null ? x.close : x)).filter(Number.isFinite);
  }
  function clone(x){ return JSON.parse(JSON.stringify(x)); }
  function eventText(e){ return typeof e === 'string' ? e : (e && e.text ? e.text : String(e || '')); }
  function eventsText(list){ return (list || []).map(eventText); }
  function settingsNow(){ return Core.settings(S.settings); }
  function isNormalBuyAction(act){
    return ['FIRST_BUY','FRONT_별지점_BUY','FRONT_평단가_BUY','FRONT_BOTH_BUY','BACK_별지점_BUY',ACTION_CRASH].includes(act);
  }
  function isSellAction(act){
    return ['QUARTER_SELL','FULL_SELL','REV_FIRST_SELL','REV_SELL'].includes(act);
  }

  window.account = function(){ return Core.createState(settingsNow()); };
  window.eq = function(a, close){ return Core.equity(a, close); };
  window.fullReset = function(a){ Core.resetPosition(a); };
  window.avgBuy = function(a, cost, shares){
    const q = Math.max(0, Math.floor(Number(shares) || 0));
    if (q <= 0) return 0;
    const p = Number(cost) / q;
    return Core.buy(a, q, p);
  };

  const baseActionLabel = window.actionLabel;
  window.actionLabel = function(a){
    if (a === ACTION_CRASH) return '급락 익일 0.25T 매수';
    if (a === 'FRONT_BOTH_BUY') return '별+평단 매수';
    return baseActionLabel(a);
  };
  window.actionOptions = function(val){
    const arr=['AUTO','CLOSE_ONLY','FIRST_BUY','FRONT_별지점_BUY','FRONT_평단가_BUY','FRONT_BOTH_BUY','BACK_별지점_BUY',ACTION_CRASH,'QUARTER_SELL','FULL_SELL','REV_FIRST_SELL','REV_SELL','REV_BUY','NORMAL_RETURN'];
    return arr.map(x=>`<option value="${x}" ${x===(val||'AUTO')?'selected':''}>${actionLabel(x)}</option>`).join('');
  };
  const manualSelect = document.getElementById('manualAction');
  if (manualSelect && !Array.from(manualSelect.options).some(o=>o.value===ACTION_CRASH)) {
    const option=document.createElement('option'); option.value=ACTION_CRASH; option.textContent=actionLabel(ACTION_CRASH);
    const quarter=Array.from(manualSelect.options).find(o=>o.value==='QUARTER_SELL');
    manualSelect.insertBefore(option, quarter || null);
  }

  function applyManualDay(a, rec, close, prior){
    const s=settingsNow();
    const pv=priorValues(prior);
    const c=Number(close);
    const crash=Core.isCrashDay(pv,c,s);
    let due=Boolean(a.pendingCrashFollowup);
    a.pendingCrashFollowup=false;
    const ev=[];

    if(a.pendingNormal){a.mode='NORMAL';a.pendingNormal=false;a.revFirst=false;Core.clearReverseBuckets(a);ev.push('리버스 일반모드 복귀 · 버킷 정리');}
    if(a.mode==='REVERSE' && due){due=false;ev.push('급락 익일 0.25T 주문 취소 · 리버스모드');}

    const act=rec.action||'AUTO';
    const p=Number(rec.tradePrice||c)||c;
    let q=Math.max(0,Math.floor(Number(rec.tradeQty)||0));
    const dayT=Number(a.T||0);

    if(act==='CLOSE_ONLY'){
      if(due) ev.push('급락 익일 0.25T LOC 미체결 · 수동 종가저장');
      ev.push('종가만 기록');
    }else if(act==='NORMAL_RETURN'){
      a.mode='NORMAL';a.pendingNormal=false;a.revFirst=false;Core.clearReverseBuckets(a);ev.push('수동: 리버스 일반복귀 · 버킷 정리');
    }else if(isNormalBuyAction(act) || act==='REV_BUY'){
      const reverseInfo=act==='REV_BUY'?Core.reverseBudgetInfo(a,p,pv,s):null;
      if(reverseInfo)q=Math.min(q,Math.floor(reverseInfo.budget/p));
      q=Core.capQty(a,p,q);
      const bought=Core.buy(a,q,p);
      if(bought>0){
        if(act==='FIRST_BUY'){a.T=dayT+1;a.cycleDay=1;}
        else if(act==='FRONT_별지점_BUY'||act==='FRONT_평단가_BUY')a.T=dayT+0.5;
        else if(act==='FRONT_BOTH_BUY'||act==='BACK_별지점_BUY')a.T=dayT+1;
        else if(act===ACTION_CRASH)a.T=dayT+s.followupT;
        else if(act==='REV_BUY'){
          a.mode='REVERSE';a.revFirst=false;
          Core.allocateReverseBuyCost(a,bought*p,reverseInfo,s);
          a.T=dayT+(s.split-dayT)*reverseInfo.ratio;
        }
        ev.push(`수동: ${actionLabel(act)} ${bought}주 @ ${price(p)} · T ${a.T.toFixed(2)}`);
        if(reverseInfo)ev.push(`리버스 버킷 ${reverseInfo.bucketCount}개 · ${(reverseInfo.ratio*100).toFixed(0)}% 적용`);
        if(isNormalBuyAction(act) && crash){a.pendingCrashFollowup=true;ev.push('급락일 매수 체결 · 다음 거래일 0.25T LOC 예약');}
      }else ev.push(`수동: ${actionLabel(act)} · 0주`);
    }else if(isSellAction(act)){
      if(act==='FULL_SELL') q=a.shares;
      q=Math.min(q,a.shares);
      const sold=Core.sell(a,q,p);
      if(sold>0){
        if(act==='FULL_SELL'){ev.push(`수동: 전량매도 ${sold}주 @ ${price(p)}`);Core.resetPosition(a);}
        else{
          if(act==='QUARTER_SELL')a.T=dayT*(1-s.quarter);
          if(act==='REV_FIRST_SELL'){
            a.mode='REVERSE';a.revFirst=false;a.T=dayT*0.9;
            Core.clearReverseBuckets(a);
            const b=Core.addReverseBucket(a,a.cash);
            ev.push(`수동: 첫 리버스 버킷 ${b?b.id:'-'}번 · ${money(a.cash)}`);
          }else if(act==='REV_SELL'){
            a.mode='REVERSE';a.revFirst=false;a.T=dayT*0.9;
            const proceeds=sold*p;
            const b=Core.addReverseBucket(a,proceeds);
            ev.push(`수동: 추가 리버스 버킷 ${b?b.id:'-'}번 · ${money(proceeds)}`);
          }
          ev.push(`수동: ${actionLabel(act)} ${sold}주 @ ${price(p)} · T ${a.T.toFixed(2)}`);
          if(a.shares<=0)Core.resetPosition(a);
        }
      }
    }

    if(rec.manualTOn){const mt=Number(rec.manualT);if(Number.isFinite(mt)){a.T=mt;ev.push(`T 직접입력 → ${a.T.toFixed(2)}`);}}
    if(isNormalBuyAction(act)&&a.shares>0&&a.T>s.split-1){a.mode='REVERSE';a.revFirst=true;Core.clearReverseBuckets(a);ev.push(`리버스 진입 예약 · T ${a.T.toFixed(2)}`);}
    return ev.length?ev:['수동 처리 없음'];
  }

  window.replay = function(){
    const a=account(),rows=[],prior=[];
    const sorted=S.records.slice().sort((x,y)=>x.date.localeCompare(y.date)||x.id-y.id);
    for(const rec of sorted){
      const close=n(rec.close),beforeShares=a.shares;
      const act=rec.action||(rec.closeOnly?'CLOSE_ONLY':'AUTO');
      let events,ma200;
      if(act==='AUTO'){
        const result=Core.processDay(a,close,priorValues(prior),settingsNow());
        events=eventsText(result.events);ma200=result.ma200;
      }else{
        events=applyManualDay(a,{...rec,action:act},close,prior);
        ma200=Core.ma200WithCurrent(priorValues(prior),close);
      }
      if(beforeShares>0&&a.shares>0)a.cycleDay=(a.cycleDay||0)+1;
      prior.push({date:rec.date,close});
      rows.push({rec,close,events,a:clone(a),equity:eq(a,close),revStar:revStarFromPrior(prior.slice(0,-1)),ma200});
    }
    return {a,rows,prior};
  };

  window.stateBeforeDate = function(d){
    const a=account(),prior=[];
    const sorted=S.records.slice().sort((x,y)=>x.date.localeCompare(y.date)||x.id-y.id);
    for(const rec of sorted){
      if(d&&rec.date>=d)break;
      const close=n(rec.close),act=rec.action||(rec.closeOnly?'CLOSE_ONLY':'AUTO');
      if(act==='AUTO')Core.processDay(a,close,priorValues(prior),settingsNow());
      else applyManualDay(a,{...rec,action:act},close,prior);
      prior.push({date:rec.date,close});
    }
    return {a,prior};
  };

  window.currentOrders = function(a,prior){
    const out=Core.buildOrders(a,priorValues(prior),settingsNow());
    const all=[...out.sells,...out.buys];
    for(const x of all){
      x.key=(x.name||'order')+'_'+(x.action||'AUTO');
      if(x.action===ACTION_CRASH||x.action==='REV_BUY')x.noLadder=true;
    }

    // Reference index UI: keep compact order rows and the +1-share LOC ladder.
    const s=settingsNow();
    const star=out.buys.find(x=>x.action==='FRONT_별지점_BUY');
    const avg=out.buys.find(x=>x.action==='FRONT_평단가_BUY');
    if(star&&avg){
      const unit=a.cash/Math.max(0.000001,s.split-a.T);
      star.noLadder=true;
      avg.avgLadder=true;
      avg.avgLimit=avg.px;
      avg.avgQty=avg.q;
      avg.ladderUnit=unit;
      avg.ladderBaseTotal=Math.max(0,Math.floor(Number(star.q)||0))+Math.max(0,Math.floor(Number(avg.q)||0));
    }

    const quarter=out.sells.find(x=>x.action==='QUARTER_SELL');
    const full=out.sells.find(x=>x.action==='FULL_SELL');
    if(full){
      full.name=`${s.target}% 지정가`;
      full.recordQty=a.shares;
      if(quarter)full.q=Math.max(0,a.shares-quarter.q);
      full.desc='쿼터 주문과 합산해 보유수량 초과 방지';
    }
    return out;
  };

  window.recommendedManualAction = function(a,close,prior){
    const preview=clone(a);
    const r=Core.processDay(preview,close,priorValues(prior),settingsNow());
    const acts=r.events.map(e=>e.action).filter(Boolean);
    const unique=[...new Set(acts)];
    const hasStar=unique.includes('FRONT_별지점_BUY');
    const hasAvg=unique.includes('FRONT_평단가_BUY');
    const otherTrades=unique.filter(x=>!['FRONT_별지점_BUY','FRONT_평단가_BUY'].includes(x));
    if(hasStar&&hasAvg&&otherTrades.length===0)return 'FRONT_BOTH_BUY';
    return unique.length===1?unique[0]:'AUTO';
  };

  window.calcQtyForAction = function(act,p,dateVal){
    const st=stateBeforeDate(dateVal||today()),a=st.a,s=settingsNow(),pv=priorValues(st.prior),px=Number(p);
    if(!(px>0))return '';
    const orders=Core.buildOrders(a,pv,s);
    const found=[...orders.buys,...orders.sells].find(x=>x.action===act);
    if(found&&found.q!=null)return Math.max(0,Math.floor(found.q));
    if(act==='REV_BUY'){const bi=Core.reverseBudgetInfo(a,px,pv,s);return Math.floor(Math.min(bi.budget,a.cash)/px);}
    if(act==='FULL_SELL')return a.shares;
    return '';
  };

  window.inferAutoAction = function(dateVal,closeVal){
    const st=stateBeforeDate(dateVal||today()),before=clone(st.a),after=clone(st.a),c=Number(closeVal);
    if(!(c>0))return {act:'AUTO',qty:'',px:'',title:'종가 입력 대기',line:'종가를 입력하면 오늘 거래를 계산합니다.',before,after,events:[]};
    const r=Core.processDay(after,c,priorValues(st.prior),settingsNow());
    const trades=r.events.filter(e=>e.action&&e.code!=='CRASH_FOLLOWUP_ORDER');
    const acts=[...new Set(trades.map(e=>e.action))];
    const hasStar=acts.includes('FRONT_별지점_BUY'),hasAvg=acts.includes('FRONT_평단가_BUY');
    let suggestedAction='AUTO',title='거래 없음',totalQty=0;
    if(hasStar&&hasAvg&&acts.every(x=>['FRONT_별지점_BUY','FRONT_평단가_BUY'].includes(x))){
      suggestedAction='FRONT_BOTH_BUY';
      totalQty=trades.reduce((sum,e)=>sum+(Number(e.qty)||0),0);
      title=`별+평단 매수 ${totalQty}주`;
    }else if(trades.length===1){
      suggestedAction=trades[0].action||'AUTO';
      totalQty=Number(trades[0].qty)||0;
      title=`${actionLabel(suggestedAction)}${totalQty?` ${totalQty}주`:''}`;
    }else if(trades.length>1){
      totalQty=trades.reduce((sum,e)=>sum+(Number(e.qty)||0),0);
      title=trades.map(e=>actionLabel(e.action)).join(' + ');
    }
    const line=`T ${before.T.toFixed(2)} → ${after.T.toFixed(2)}${after.pendingCrashFollowup?' · 0.25T 예약':''}`;
    return {act:'AUTO',suggestedAction,qty:totalQty||'',px:c,title,line,before,after,events:r.events};
  };

  function promoteTypedQtyToRecommendedAction(){
    const qtyEl=$('m_tradeQty');
    if(!qtyEl || qtyEl.value==='') return {typed:false,promoted:false};
    const c=Number($('m_close').value),dateVal=$('m_date').value||today();
    if(!(c>0)) return {typed:true,promoted:false};
    const current=$('m_manualAction').value||'AUTO';
    if(window.__v40ManualChoice && current!=='AUTO') return {typed:true,promoted:true,action:current};
    const st=stateBeforeDate(dateVal);
    const act=recommendedManualAction(st.a,c,st.prior);
    if(!act || act==='AUTO' || act==='CLOSE_ONLY' || act==='NORMAL_RETURN') return {typed:true,promoted:false,action:act||'AUTO'};
    const rawQty=qtyEl.value;
    window.__v40ManualChoice=true;
    $('m_manualAction').value=act;
    if(!$('m_tradePrice').value) $('m_tradePrice').value=c.toFixed(2);
    qtyEl.value=Math.max(0,Math.floor(Number(rawQty)||0));
    return {typed:true,promoted:true,action:act};
  }

  window.autoSelectFromClose = function(){
    if(!$('m_close'))return;
    if(!window.__v40ManualChoice){$('m_manualAction').value='AUTO';$('m_tradePrice').value='';$('m_tradeQty').value='';}
    updateSelectedAction();estimateTForInput();
  };

  window.setModalAction = function(act,priceVal,qtyVal){
    window.__v40ManualChoice=(act||'AUTO')!=='AUTO';
    $('m_manualAction').value=act||'AUTO';
    if(window.__v40ManualChoice){
      if(priceVal!==undefined&&priceVal!==null&&priceVal!=='')$('m_tradePrice').value=Number(priceVal).toFixed(2);
      const q=calcQtyForAction(act,Number($('m_tradePrice').value||$('m_close').value),$('m_date').value||today());
      $('m_tradeQty').value=q===''?'':Math.max(0,Math.floor(q));
    }else{$('m_tradePrice').value='';$('m_tradeQty').value='';}
    updateSelectedAction();estimateTForInput();
  };

  window.updateSelectedAction = function(){
    promoteTypedQtyToRecommendedAction();
    const c=Number($('m_close').value),dateVal=$('m_date').value||today();
    if(!window.__v40ManualChoice){
      const r=inferAutoAction(dateVal,c);
      $('selectedActionTitle').textContent=c?r.title:'자동 방어형 처리';
      $('selectedActionLine').textContent=r.line;
      $('sheetDateLabel').textContent=dateVal;
      return;
    }
    const act=$('m_manualAction').value||'AUTO',p=Number($('m_tradePrice').value||c),q=$('m_tradeQty').value;
    $('selectedActionTitle').textContent=actionLabel(act);$('sheetDateLabel').textContent=dateVal;
    $('selectedActionLine').textContent=`${p?price(p):'체결가'}${q?` × ${q}주`:''} · 수동 기록`;
  };

  window.estimateTForInput = function(){
    if(!$('autoTPreview'))return;
    promoteTypedQtyToRecommendedAction();
    const dateVal=$('m_date').value||today(),c=Number($('m_close').value),st=stateBeforeDate(dateVal),before=st.a.T;
    if(!(c>0)){$('autoTPreview').textContent='—';return;}
    if(!window.__v40ManualChoice){const r=inferAutoAction(dateVal,c);$('autoTPreview').textContent=`${before.toFixed(2)} → ${r.after.T.toFixed(2)}`;return;}
    const p=Number($('m_tradePrice').value||c),q=Number($('m_tradeQty').value||0),preview=clone(st.a);
    applyManualDay(preview,{action:$('m_manualAction').value,tradePrice:p,tradeQty:q,manualTOn:$('m_manualTOn').checked,manualT:$('m_manualT').value},c,st.prior);
    $('autoTPreview').textContent=`${before.toFixed(2)} → ${preview.T.toFixed(2)}`;
  };

  window.fillModalChoices = function(){
    if(!$('modalChoices'))return;
    const dateVal=$('m_date').value||today(),c=Number($('m_close').value),st=stateBeforeDate(dateVal),ord=currentOrders(st.a,st.prior),items=[];
    items.push('<div class="choiceTitle">오늘 추천</div>');
    if(c>0){
      const r=inferAutoAction(dateVal,c);
      const qtxt=r.qty?` × ${qty(r.qty)}주`:'';
      items.push(`<button type="button" class="choice selected" data-mact="AUTO"><strong>${esc(r.title)}</strong><small>${price(c)}${qtxt}</small><span class="tag">${esc(r.line)}</span></button>`);
    }else items.push('<div class="note">종가를 입력하면 오늘 거래를 자동 계산합니다.</div>');

    const add=(title,arr,cls)=>{
      if(!arr.length)return;
      items.push(`<div class="choiceTitle">${title}</div>`);
      for(const x of arr){
        items.push(`<button type="button" class="choice ${cls}" data-mact="${x.action}" data-mprice="${x.px==null?'':x.px}" data-mqty="${x.q==null?'':x.q}"><strong>${esc(x.name)}</strong><small>${x.px==null?'—':price(x.px)}${x.q!=null?' × '+qty(x.q)+'주':''}</small><span class="tag hideQtyTag">선택</span></button>`);
        if(x.kind==='buy'&&typeof simpleBuyExtraRows==='function'){
          const extras=simpleBuyExtraRows(x)||[];
          for(const r of extras){
            items.push(`<div class="choice ladderChoice"><strong>+1주 LOC</strong><small>${price(r.px)}</small><span class="tag hideQtyTag">총 ${qty(r.total||((x.q||0)+1))}주</span></div>`);
          }
        }
      }
    };
    add('매수',ord.buys.filter(x=>x.action!=='AUTO'),'buyChoice');
    add('매도',ord.sells.filter(x=>x.action!=='AUTO'),'sellChoice');
    items.push('<div class="choiceTitle">기타</div><button type="button" class="choice" data-mact="CLOSE_ONLY"><strong>종가만 저장</strong><small>거래 없음</small><span class="tag hideQtyTag">저장</span></button>');
    $('modalChoices').innerHTML=items.join('');
    document.querySelectorAll('[data-mact]').forEach(b=>b.onclick=()=>setModalAction(b.dataset.mact,b.dataset.mprice,b.dataset.mqty));
  };

  window.openSheet = function(){
    window.__v40ManualChoice=false;
    syncModalFromMain();
    window.__v40ManualChoice=false;
    $('m_manualAction').value='AUTO';$('m_tradePrice').value='';$('m_tradeQty').value='';
    updateSelectedAction();estimateTForInput();fillModalChoices();
    $('recordSheet').classList.add('open');$('recordSheet').setAttribute('aria-hidden','false');
    setTimeout(()=>($('m_close').value?$('m_close'):$('m_close')).focus(),80);
  };

  window.modalSave = function(){
    const promoted=promoteTypedQtyToRecommendedAction();
    if(promoted.typed && !promoted.promoted){
      alert('오늘은 여러 거래가 함께 발생하는 날입니다. 아래 매수·매도 줄에서 적용할 거래를 선택해 주세요.');
      return;
    }
    if(!window.__v40ManualChoice){$('m_manualAction').value='AUTO';$('m_tradePrice').value='';$('m_tradeQty').value='';}
    syncMainFromModal();addRecord();closeSheet();
  };

  const oldCompactTradeLine=window.compactTradeLine;
  window.compactTradeLine=function(row){
    const act=row.rec.action||(row.rec.closeOnly?'CLOSE_ONLY':'AUTO');
    if(act==='AUTO'){
      const meaningful=(row.events||[]).filter(x=>!String(x).startsWith('급락 익일 대체 LOC'));
      const text=meaningful.length?meaningful.join(' · '):'자동 · 거래 없음';
      return `<div class="simpleTradeText"><span class="simpleTradeAction info">자동</span><span class="simpleTradePx">${esc(text)}</span></div>`;
    }
    return oldCompactTradeLine(row);
  };

  const oldRender=window.render;
  window.render=function(){
    oldRender();
    const R=replay(),a=R.a;
    const phase=$('phase');
    if(phase&&a.pendingCrashFollowup)phase.textContent='급락 익일 0.25T 예약';
    let box=$('defensiveStatus');
    if(!box){
      box=document.createElement('div');box.id='defensiveStatus';box.className='note';box.style.marginTop='10px';
      const overview=$('overview');if(overview)overview.appendChild(box);
    }
    if(box){
      const last=R.prior.length?R.prior[R.prior.length-1].close:null;
      const ma=last!=null?Core.ma200WithCurrent(priorValues(R.prior.slice(0,-1)),last):null;
      const buckets=Core.ensureReverseBuckets(a),bucketRemain=buckets.reduce((sum,b)=>sum+b.remaining,0);
      box.innerHTML=`<b>방어형</b> · 급락예약 ${a.pendingCrashFollowup?'<span class="red">있음</span>':'없음'} · MA200 ${ma==null?'—':price(ma)} · 버킷 ${buckets.length}개`;
    }
  };

  function ensureReferenceUiStyle(){
    if(document.getElementById('v8ReferenceUiStyle'))return;
    const st=document.createElement('style');st.id='v8ReferenceUiStyle';
    st.textContent='.choice.ladderChoice{padding:8px 12px;margin:-3px 0 5px;background:#eaf7f1;border-color:#d7efe2;cursor:default}.choice.ladderChoice strong{font-size:13px;color:#5f596d}.choice.ladderChoice small{font-size:13px;font-weight:950;color:#2c9a73}.choice.ladderChoice .tag{font-size:11px}.recTop .line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.choice small{margin-left:auto;white-space:nowrap}.choiceTitle{margin-top:8px}';
    document.head.appendChild(st);
  }

  function updateStaticUi(){
    document.title='SOXL V4 방어형 계산기 · 리버스 버킷 · 22/22/Q1/3';
    const h1=document.querySelector('.title h1');if(h1)h1.textContent='SOXL V4 방어형 계산기';
    const sub=document.querySelector('.subtitle');if(sub)sub.textContent='22/22 · 쿼터 1/3 · 급락 0.25T · 리버스 25/5';
    const badge=document.querySelector('.badge');if(badge)badge.textContent='DEFENSIVE BUCKET';
    const rules=document.querySelector('#rules tbody');
    if(rules&&!document.getElementById('defensiveRuleRows')){
      const marker=document.createElement('tbody');marker.id='defensiveRuleRows';
      rules.insertAdjacentHTML('beforeend','<tr><th>당일 상태</th><td>별지점·1회매수금·전반/후반은 당일 시작 T·현금·평단으로 고정</td></tr><tr><th>급락 방어</th><td>종가수익률 -22.5% 이하인 날 정상매수가 체결되면 다음 거래일 정상매수를 0.25T 단일 LOC로 대체</td></tr><tr><th>대체 LOC</th><td>전반: 별지점과 평단가 LOC 중 높은 값, 후반: 별지점 LOC. 미체결 시 당일 소멸</td></tr><tr><th>리버스 버킷</th><td>첫 리버스 매도 후 전체 현금을 1번 버킷으로 만들고, 이후 매도대금마다 독립 버킷 추가. 실제 매수금은 버킷별 비례차감</td></tr><tr><th>리버스 매수</th><td>당일 종가 포함 MA200의 85% 이상은 25%, 85% 미만은 5%; 200일 미만은 25%. 매수예산과 T 회복률에 동일 적용. T = T + (20-T)×당일 비율</td></tr><tr><th>현금 상한</th><td>모든 매수수량은 floor(예산/가격) 후 실제 보유현금으로 다시 제한</td></tr>');
    }
  }

  function rebind(){
    if($('openRecordSheet'))$('openRecordSheet').onclick=openSheet;
    if($('navRecord'))$('navRecord').onclick=e=>{e.preventDefault();openSheet();};
    if($('modalSaveDay'))$('modalSaveDay').onclick=modalSave;
    if($('quickSaveRecord'))$('quickSaveRecord').onclick=modalSave;
    if($('modalCloseOnly'))$('modalCloseOnly').onclick=()=>{setModalAction('CLOSE_ONLY');modalSave();};
  }

  ensureReferenceUiStyle();
  updateStaticUi();
  rebind();
  render();
})();
