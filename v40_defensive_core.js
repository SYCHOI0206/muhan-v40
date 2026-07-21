(function(root, factory){
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.V40DefensiveCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const DEFAULTS = Object.freeze({
    seed: 10000,
    split: 20,
    starBase: 22,
    target: 22,
    quarter: 1 / 3,
    crashThreshold: -0.225,
    followupT: 0.25,
    reverseProfile: 'DEFENSIVE',
    reverseBucketAllocation: 'PROPORTIONAL'
  });

  function num(v, fallback){
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  }

  function settings(input){
    const s = Object.assign({}, DEFAULTS, input || {});
    s.seed = num(s.seed, DEFAULTS.seed);
    s.split = num(s.split, DEFAULTS.split);
    s.starBase = num(s.starBase, DEFAULTS.starBase);
    s.target = num(s.target, DEFAULTS.target);
    s.quarter = num(s.quarter, DEFAULTS.quarter);
    s.crashThreshold = num(s.crashThreshold, DEFAULTS.crashThreshold);
    s.followupT = num(s.followupT, DEFAULTS.followupT);
    s.reverseProfile = String(s.reverseProfile || DEFAULTS.reverseProfile).toUpperCase();
    s.reverseBucketAllocation = String(s.reverseBucketAllocation || DEFAULTS.reverseBucketAllocation).toUpperCase();
    return s;
  }

  function createState(inputSettings){
    const s = settings(inputSettings);
    return {
      cash: s.seed,
      shares: 0,
      avg: null,
      T: 0,
      cycle: 1,
      mode: 'NORMAL',
      revFirst: false,
      pendingNormal: false,
      pendingCrashFollowup: false,
      reverseBuckets: [],
      reverseBucketSeq: 0,
      cycleDay: 0
    };
  }

  function cloneState(state){
    return JSON.parse(JSON.stringify(state));
  }

  function equity(state, close){
    return num(state.cash, 0) + num(state.shares, 0) * num(close, 0);
  }

  function resetPosition(state){
    state.shares = 0;
    state.avg = null;
    state.T = 0;
    state.mode = 'NORMAL';
    state.revFirst = false;
    state.pendingNormal = false;
    state.pendingCrashFollowup = false;
    state.reverseBuckets = [];
    state.reverseBucketSeq = 0;
    state.cycle = num(state.cycle, 1) + 1;
    state.cycleDay = 0;
  }

  function capQty(state, price, requested){
    const p = num(price, 0);
    if (p <= 0) return 0;
    return Math.max(0, Math.min(Math.floor(num(requested, 0)), Math.floor(Math.max(0, state.cash) / p)));
  }

  function buy(state, qty, price){
    const p = num(price, 0);
    const q = capQty(state, p, qty);
    if (p <= 0 || q <= 0) return 0;
    const oldCost = num(state.avg, 0) * num(state.shares, 0);
    const cost = q * p;
    state.cash -= cost;
    state.shares += q;
    state.avg = (oldCost + cost) / state.shares;
    return q;
  }

  function sell(state, qty, price){
    const p = num(price, 0);
    const q = Math.max(0, Math.min(Math.floor(num(qty, 0)), Math.floor(num(state.shares, 0))));
    if (p <= 0 || q <= 0) return 0;
    state.cash += q * p;
    state.shares -= q;
    return q;
  }

  function previousClose(priorCloses){
    if (!Array.isArray(priorCloses) || !priorCloses.length) return null;
    const x = num(priorCloses[priorCloses.length - 1], NaN);
    return Number.isFinite(x) ? x : null;
  }

  function isCrashDay(priorCloses, close, inputSettings){
    const s = settings(inputSettings);
    const prev = previousClose(priorCloses);
    const c = num(close, 0);
    if (!(prev != null && prev > 0 && c > 0)) return false;
    const thresholdPrice = prev * (1 + s.crashThreshold);
    const tolerance = Math.max(1e-10, Math.abs(prev) * 1e-12);
    return c <= thresholdPrice + tolerance;
  }

  function ma200WithCurrent(priorCloses, close){
    const prior = Array.isArray(priorCloses) ? priorCloses.map(Number).filter(Number.isFinite) : [];
    const c = num(close, NaN);
    if (!Number.isFinite(c) || prior.length < 199) return null;
    const window = prior.slice(-199).concat([c]);
    return window.reduce((a, b) => a + b, 0) / 200;
  }

  function ensureReverseBuckets(state){
    if (!Array.isArray(state.reverseBuckets)) state.reverseBuckets = [];
    state.reverseBuckets = state.reverseBuckets
      .map((b, i) => ({
        id: b && b.id != null ? b.id : i + 1,
        principal: Math.max(0, num(b && b.principal, 0)),
        remaining: Math.max(0, num(b && b.remaining, num(b && b.principal, 0)))
      }))
      .filter(b => b.principal > 1e-9 && b.remaining > 1e-9);
    state.reverseBucketSeq = Math.max(
      Math.floor(num(state.reverseBucketSeq, 0)),
      ...state.reverseBuckets.map(b => Math.floor(num(b.id, 0))),
      0
    );
    return state.reverseBuckets;
  }

  function clearReverseBuckets(state){
    state.reverseBuckets = [];
    state.reverseBucketSeq = 0;
  }

  function addReverseBucket(state, principal){
    const amount = Math.max(0, num(principal, 0));
    if (amount <= 1e-9) return null;
    ensureReverseBuckets(state);
    state.reverseBucketSeq += 1;
    const bucket = { id: state.reverseBucketSeq, principal: amount, remaining: amount };
    state.reverseBuckets.push(bucket);
    return bucket;
  }

  function reverseRatioInfo(close, priorCloses, inputSettings){
    const s = settings(inputSettings);
    const c = num(close, 0);
    const ma200 = ma200WithCurrent(priorCloses, c);
    if (s.reverseProfile === 'ORIGINAL') {
      return { ma200, ratio: 0.25, zone: '원문 V4 · 버킷별 25%' };
    }
    if (ma200 == null) return { ma200, ratio: 0.25, zone: 'MA200 데이터 부족 · 버킷별 25%' };
    if (c >= ma200 * 0.85) return { ma200, ratio: 0.25, zone: 'MA200의 85% 이상 · 버킷별 25%' };
    return { ma200, ratio: 0.05, zone: 'MA200의 85% 미만 · 버킷별 5%' };
  }

  function reverseBudgetInfo(state, close, priorCloses, inputSettings){
    const ratioInfo = reverseRatioInfo(close, priorCloses, inputSettings);
    const buckets = ensureReverseBuckets(state);
    const parts = buckets.map(b => ({
      id: b.id,
      principal: b.principal,
      remaining: b.remaining,
      requested: Math.min(b.remaining, b.principal * ratioInfo.ratio)
    })).filter(x => x.requested > 1e-9);
    const planned = parts.reduce((sum, x) => sum + x.requested, 0);
    const budget = Math.min(Math.max(0, num(state.cash, 0)), planned);
    return {
      ma200: ratioInfo.ma200,
      ratio: ratioInfo.ratio,
      zone: ratioInfo.zone,
      budget,
      planned,
      parts,
      bucketCount: buckets.length,
      totalPrincipal: buckets.reduce((sum, b) => sum + b.principal, 0),
      totalRemaining: buckets.reduce((sum, b) => sum + b.remaining, 0)
    };
  }

  function allocateReverseBuyCost(state, cost, budgetInfo, inputSettings){
    const s = settings(inputSettings);
    const buckets = ensureReverseBuckets(state);
    const parts = budgetInfo && Array.isArray(budgetInfo.parts) ? budgetInfo.parts : [];
    let remainingCost = Math.max(0, num(cost, 0));
    if (remainingCost <= 1e-9 || !parts.length) return 0;
    const byId = new Map(buckets.map(b => [String(b.id), b]));
    const totalRequested = parts.reduce((sum, x) => sum + Math.max(0, num(x.requested, 0)), 0);
    if (totalRequested <= 1e-9) return 0;
    let allocated = 0;

    if (s.reverseBucketAllocation === 'FIFO') {
      for (const part of parts) {
        if (remainingCost <= 1e-9) break;
        const bucket = byId.get(String(part.id));
        if (!bucket) continue;
        const take = Math.min(bucket.remaining, Math.max(0, num(part.requested, 0)), remainingCost);
        bucket.remaining -= take;
        remainingCost -= take;
        allocated += take;
      }
    } else {
      let open = parts.slice();
      while (remainingCost > 1e-8 && open.length) {
        const openTotal = open.reduce((sum, x) => sum + Math.max(0, num(x.requested, 0)), 0);
        if (openTotal <= 1e-9) break;
        let usedThisRound = 0;
        const next = [];
        for (const part of open) {
          const bucket = byId.get(String(part.id));
          if (!bucket || bucket.remaining <= 1e-9) continue;
          const share = remainingCost * Math.max(0, num(part.requested, 0)) / openTotal;
          const cap = Math.min(bucket.remaining, Math.max(0, num(part.requested, 0)));
          const take = Math.min(cap, share);
          bucket.remaining -= take;
          usedThisRound += take;
          allocated += take;
          if (cap - take > 1e-8) next.push({ ...part, requested: cap - take });
        }
        if (usedThisRound <= 1e-9) break;
        remainingCost -= usedThisRound;
        open = next;
      }
    }

    state.reverseBuckets = buckets.filter(b => b.remaining > 1e-7);
    return allocated;
  }

  function startDaySnapshot(state, inputSettings){
    const s = settings(inputSettings);
    const dayT = num(state.T, 0);
    const dayCash = num(state.cash, 0);
    const dayAvg = num(state.avg, NaN);
    if (!Number.isFinite(dayAvg) || dayAvg <= 0) {
      return { dayT, dayCash, dayAvg: null, targetPrice: null, starPct: null, starPrice: null, starBuyPrice: null, avgBuyPrice: null, unit: dayCash / s.split };
    }
    const starPct = s.starBase * (1 - 2 * dayT / s.split);
    const starPrice = dayAvg * (1 + starPct / 100);
    const unit = dayT < s.split ? dayCash / Math.max(1e-9, s.split - dayT) : 0;
    return {
      dayT,
      dayCash,
      dayAvg,
      targetPrice: dayAvg * (1 + s.target / 100),
      starPct,
      starPrice,
      starBuyPrice: starPrice - 0.01,
      avgBuyPrice: dayAvg - 0.01,
      unit
    };
  }

  function event(code, text, extra){
    return Object.assign({ code, text }, extra || {});
  }

  function processDay(state, close, priorCloses, inputSettings){
    const s = settings(inputSettings);
    const c = num(close, 0);
    if (!(c > 0)) throw new Error('종가는 0보다 커야 합니다.');
    const prior = Array.isArray(priorCloses) ? priorCloses : [];
    const events = [];
    const crash = isCrashDay(prior, c, s);
    const ma200 = ma200WithCurrent(prior, c);

    let dueFollowup = Boolean(state.pendingCrashFollowup);
    state.pendingCrashFollowup = false;

    if (state.pendingNormal) {
      state.mode = 'NORMAL';
      state.pendingNormal = false;
      state.revFirst = false;
      clearReverseBuckets(state);
      events.push(event('NORMAL_RESUME', '리버스 일반모드 복귀'));
    }

    if (state.mode === 'REVERSE' && dueFollowup) {
      dueFollowup = false;
      events.push(event('CRASH_FOLLOWUP_CANCEL_REVERSE', '급락 익일 0.25T 주문 취소 · 리버스모드'));
    }

    if (state.shares <= 0 || state.avg == null) {
      const budget = Math.max(0, state.cash) / s.split;
      const requested = Math.floor(budget / c);
      const q = buy(state, requested, c);
      if (q > 0) {
        state.T += 1;
        state.cycleDay = 1;
        events.push(event('FIRST_BUY', `첫 매수 ${q}주`, { action: 'FIRST_BUY', qty: q, price: c, budget }));
        if (crash) {
          state.pendingCrashFollowup = true;
          events.push(event('CRASH_FOLLOWUP_SCHEDULED', '급락일 매수 체결 · 다음 거래일 0.25T LOC 예약'));
        }
      } else {
        events.push(event('FIRST_BUY_0', '첫 매수 신호 · 현금 부족 또는 0주'));
      }
      if (dueFollowup) events.push(event('CRASH_FOLLOWUP_CANCEL_NO_POSITION', '급락 익일 주문 취소 · 포지션 없음'));
      return { events, crash, ma200, dueFollowup: false, equity: equity(state, c) };
    }

    const snap = startDaySnapshot(state, s);

    if (state.mode === 'NORMAL') {
      if (c >= snap.targetPrice) {
        if (dueFollowup) events.push(event('CRASH_FOLLOWUP_CANCEL_FULL_EXIT', '급락 익일 주문 취소 · 전량매도 우선'));
        const q = state.shares;
        sell(state, q, c);
        events.push(event('FULL_EXIT', `전량매도 ${q}주`, { action: 'FULL_SELL', qty: q, price: c }));
        resetPosition(state);
        return { events, crash, ma200, dueFollowup: false, equity: equity(state, c), snapshot: snap };
      }

      if (c >= snap.starPrice) {
        const q = Math.floor(state.shares * s.quarter);
        const sold = sell(state, q, c);
        if (sold > 0) {
          state.T = snap.dayT * (1 - s.quarter);
          events.push(event('QUARTER_SELL', `쿼터매도 ${sold}주`, { action: 'QUARTER_SELL', qty: sold, price: c }));
        }
      }

      let buyHappened = false;

      if (dueFollowup) {
        if (state.shares > 0 && snap.dayT < s.split) {
          const budget = Math.min(snap.unit * s.followupT, Math.max(0, state.cash));
          const front = snap.dayT < s.split / 2;
          const limit = front ? Math.max(snap.starBuyPrice, snap.avgBuyPrice) : snap.starBuyPrice;
          events.push(event('CRASH_FOLLOWUP_ORDER', `급락 익일 대체 LOC ${front ? '전반' : '후반'} · ${limit.toFixed(2)} 이하`, { action: 'CRASH_FOLLOWUP_BUY', price: limit, budget }));
          if (c <= limit) {
            const requested = Math.floor(budget / c);
            const q = buy(state, requested, c);
            if (q > 0) {
              state.T += s.followupT;
              buyHappened = true;
              events.push(event('CRASH_FOLLOWUP_BUY', `급락 익일 0.25T 매수 ${q}주`, { action: 'CRASH_FOLLOWUP_BUY', qty: q, price: c, budget }));
            } else {
              events.push(event('CRASH_FOLLOWUP_BUY_0', '급락 익일 0.25T 매수 신호 · 0주'));
            }
          } else {
            events.push(event('CRASH_FOLLOWUP_UNFILLED', '급락 익일 0.25T LOC 미체결'));
          }
        }
      } else if (snap.dayT < s.split / 2) {
        const hitStar = c <= snap.starBuyPrice;
        const hitAvg = c <= snap.avgBuyPrice;
        const half = snap.unit / 2;

        if (hitStar && hitAvg) {
          const requestedStar = Math.floor(half / c);
          const starQ = buy(state, requestedStar, c);
          const requestedAvg = Math.floor(half / c);
          const avgQ = buy(state, requestedAvg, c);
          if (starQ > 0 || avgQ > 0) {
            state.T += 0.5 * Number(starQ > 0) + 0.5 * Number(avgQ > 0);
            buyHappened = true;
            if (starQ > 0) events.push(event('STAR_BUY_HALF', `별지점 매수 ${starQ}주`, { action: 'FRONT_별지점_BUY', qty: starQ, price: c, budget: half }));
            if (avgQ > 0) events.push(event('AVG_BUY_HALF', `평단가 매수 ${avgQ}주`, { action: 'FRONT_평단가_BUY', qty: avgQ, price: c, budget: half }));
          }
        } else if (hitStar) {
          const q = buy(state, Math.floor(half / c), c);
          if (q > 0) {
            state.T += 0.5;
            buyHappened = true;
            events.push(event('STAR_BUY_HALF', `별지점 매수 ${q}주`, { action: 'FRONT_별지점_BUY', qty: q, price: c, budget: half }));
          }
        } else if (hitAvg) {
          const q = buy(state, Math.floor(half / c), c);
          if (q > 0) {
            state.T += 0.5;
            buyHappened = true;
            events.push(event('AVG_BUY_HALF', `평단가 매수 ${q}주`, { action: 'FRONT_평단가_BUY', qty: q, price: c, budget: half }));
          }
        }
      } else if (c <= snap.starBuyPrice) {
        const q = buy(state, Math.floor(snap.unit / c), c);
        if (q > 0) {
          state.T += 1;
          buyHappened = true;
          events.push(event('STAR_BUY_FULL', `별지점 매수 ${q}주`, { action: 'BACK_별지점_BUY', qty: q, price: c, budget: snap.unit }));
        }
      }

      if (crash && buyHappened) {
        state.pendingCrashFollowup = true;
        events.push(event('CRASH_FOLLOWUP_SCHEDULED', '급락일 매수 체결 · 다음 거래일 0.25T LOC 예약'));
      }

      if (state.shares > 0 && state.T > s.split - 1) {
        state.mode = 'REVERSE';
        state.revFirst = true;
        clearReverseBuckets(state);
        events.push(event('REVERSE_ENTER', `리버스 진입 · T ${state.T.toFixed(2)}`));
      }
    } else {
      if (state.revFirst) {
        const q = Math.floor(state.shares / 10);
        const sold = sell(state, q, c);
        const firstPrincipal = Math.max(0, state.cash);
        clearReverseBuckets(state);
        const bucket = addReverseBucket(state, firstPrincipal);
        if (sold > 0) {
          state.T *= 0.9;
          events.push(event('REVERSE_FIRST_SELL', `리버스 첫날 매도 ${sold}주 · 1번 버킷 ${firstPrincipal.toFixed(2)}`, { action: 'REV_FIRST_SELL', qty: sold, price: c, bucketPrincipal: firstPrincipal, bucketId: bucket && bucket.id }));
        } else {
          events.push(event('REVERSE_FIRST_SELL_0', `리버스 첫날 매도 0주 · 기존 현금 버킷 ${firstPrincipal.toFixed(2)}`));
        }
        state.revFirst = false;
      } else {
        const revStar = prior.length >= 5 ? prior.slice(-5).reduce((a, b) => a + num(b, 0), 0) / 5 : null;
        if (c > state.avg * 0.8) {
          state.pendingNormal = true;
          events.push(event('REVERSE_EXIT_PENDING', '리버스 탈출 신호 · 다음 거래일 일반복귀'));
        } else if (revStar != null && c >= revStar) {
          const q = Math.floor(state.shares / 10);
          const cashBefore = state.cash;
          const sold = sell(state, q, c);
          if (sold > 0) {
            const proceeds = state.cash - cashBefore;
            const bucket = addReverseBucket(state, proceeds);
            state.T *= 0.9;
            events.push(event('REVERSE_SELL', `리버스 매도 ${sold}주 · ${bucket ? bucket.id : '-'}번 버킷 ${proceeds.toFixed(2)}`, { action: 'REV_SELL', qty: sold, price: c, revStar, bucketPrincipal: proceeds, bucketId: bucket && bucket.id }));
          }
        } else if (revStar != null && c <= revStar - 0.01) {
          const info = reverseBudgetInfo(state, c, prior, s);
          const q = buy(state, Math.floor(info.budget / c), c);
          if (q > 0) {
            const cost = q * c;
            allocateReverseBuyCost(state, cost, info, s);
            state.T = state.T + (s.split - state.T) * info.ratio;
            events.push(event('REVERSE_BUY', `리버스 매수 ${q}주 · ${info.zone} · ${info.bucketCount}개 버킷`, { action: 'REV_BUY', qty: q, price: c, budget: info.budget, cost, ma200: info.ma200, ratio: info.ratio, revStar, bucketCount: info.bucketCount, bucketRemaining: ensureReverseBuckets(state).reduce((sum, b) => sum + b.remaining, 0) }));
          } else {
            events.push(event('REVERSE_BUY_0', `리버스 매수 신호 · ${info.zone} · 예산 또는 정수주 부족`, { budget: info.budget, ratio: info.ratio, bucketCount: info.bucketCount }));
          }
        }
      }
    }

    return { events, crash, ma200, dueFollowup, equity: equity(state, c), snapshot: snap };
  }

  function buildOrders(state, priorCloses, inputSettings){
    const s = settings(inputSettings);
    const prior = Array.isArray(priorCloses) ? priorCloses : [];
    const last = previousClose(prior);
    const sells = [];
    const buys = [];

    if (last == null) {
      buys.push({ name: '초기 종가 입력 필요', kind: 'info', action: 'AUTO', px: null, q: null, desc: '종가 입력 후 첫 매수 수량 계산' });
      return { sells, buys };
    }

    const work = cloneState(state);
    if (work.pendingNormal) {
      work.mode = 'NORMAL';
      work.pendingNormal = false;
      work.revFirst = false;
      sells.push({ name: '일반모드 복귀', kind: 'info', action: 'NORMAL_RETURN', px: null, q: null, desc: '다음 거래일 일반모드로 복귀 후 정상 주문 실행' });
    }

    if (work.mode === 'REVERSE') {
      if (work.revFirst) {
        sells.push({ name: '리버스 첫날 매도', kind: 'sell', action: 'REV_FIRST_SELL', px: last, q: Math.floor(work.shares / 10), desc: '보유수량 1/10 · 종가 MOC' });
        return { sells, buys };
      }
      const revStar = prior.length >= 5 ? prior.slice(-5).reduce((a, b) => a + num(b, 0), 0) / 5 : null;
      if (work.avg != null) sells.push({ name: '리버스 탈출 조건', kind: 'info', action: 'AUTO', px: work.avg * 0.8, q: null, desc: '종가가 평단×0.80 초과 시 거래 없이 다음 날 일반복귀' });
      if (revStar == null) {
        buys.push({ name: '리버스 데이터 부족', kind: 'info', action: 'AUTO', px: null, q: null, desc: '직전 5거래일 종가 필요' });
        return { sells, buys };
      }
      sells.push({ name: '리버스 매도', kind: 'sell', action: 'REV_SELL', px: revStar, q: Math.floor(work.shares / 10), desc: '직전 5일 평균 이상 · 보유수량 1/10' });
      const buyPx = revStar - 0.01;
      const info = reverseBudgetInfo(work, last, prior.slice(0, -1), s);
      buys.push({ name: '리버스 매수', kind: 'buy', action: 'REV_BUY', px: buyPx, q: Math.floor(info.budget / buyPx), budget: info.budget, desc: `${info.zone} · 활성 버킷 ${info.bucketCount}개 · 체결 종가 포함 MA200으로 최종 확정` });
      return { sells, buys };
    }

    if (work.shares <= 0 || work.avg == null) {
      const budget = work.cash / s.split;
      buys.push({ name: '첫 매수', kind: 'buy', action: 'FIRST_BUY', px: last, q: Math.floor(budget / last), budget, desc: '1회매수금 · 종가 기준' });
      return { sells, buys };
    }

    const snap = startDaySnapshot(work, s);
    const quarterQty = Math.floor(work.shares * s.quarter);
    sells.push({ name: `${s.target}% 전량매도`, kind: 'stop', action: 'FULL_SELL', px: snap.targetPrice, q: work.shares, desc: '종가가 목표 이상이면 전량 LOC' });
    sells.push({ name: '쿼터매도', kind: 'sell', action: 'QUARTER_SELL', px: snap.starPrice, q: quarterQty, desc: `보유수량 ${(s.quarter * 100).toFixed(1)}% · T×${(1 - s.quarter).toFixed(4)}` });

    if (work.pendingCrashFollowup) {
      const front = snap.dayT < s.split / 2;
      const px = front ? Math.max(snap.starBuyPrice, snap.avgBuyPrice) : snap.starBuyPrice;
      const budget = Math.min(snap.unit * s.followupT, work.cash);
      buys.push({ name: '급락 익일 대체매수', kind: 'buy', action: 'CRASH_FOLLOWUP_BUY', px, q: Math.floor(budget / px), budget, desc: `정상매수 대체 · ${s.followupT.toFixed(2)}T · ${front ? '별/평단 중 높은 LOC' : '별지점 LOC'}` });
      return { sells, buys };
    }

    if (snap.dayT < s.split / 2) {
      const half = snap.unit / 2;
      buys.push({ name: '별지점 매수', kind: 'buy', action: 'FRONT_별지점_BUY', px: snap.starBuyPrice, q: Math.floor(half / snap.starBuyPrice), budget: half, desc: '당일 시작 T 기준 전반전 · 1회매수금 1/2' });
      buys.push({ name: '평단가 매수', kind: 'buy', action: 'FRONT_평단가_BUY', px: snap.avgBuyPrice, q: Math.floor(half / snap.avgBuyPrice), budget: half, desc: '당일 시작 T 기준 전반전 · 1회매수금 1/2' });
    } else {
      buys.push({ name: '별지점 매수', kind: 'buy', action: 'BACK_별지점_BUY', px: snap.starBuyPrice, q: Math.floor(snap.unit / snap.starBuyPrice), budget: snap.unit, desc: '당일 시작 T 기준 후반전 · 1회매수금' });
    }
    return { sells, buys };
  }

  return {
    DEFAULTS,
    settings,
    createState,
    cloneState,
    equity,
    resetPosition,
    capQty,
    buy,
    sell,
    previousClose,
    isCrashDay,
    ma200WithCurrent,
    ensureReverseBuckets,
    clearReverseBuckets,
    addReverseBucket,
    reverseRatioInfo,
    reverseBudgetInfo,
    allocateReverseBuyCost,
    startDaySnapshot,
    processDay,
    buildOrders
  };
});
