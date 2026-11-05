// 大肥鱼的家 · 面板
// 这一段函数体会被面板用 new Function('React','h','ui','call', src) 执行，最后要 return 一个组件。
const { useState, useEffect } = React;

const box = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 };
const inputStyle = { width: '100%', boxSizing: 'border-box' };
const chipStyle = {
  padding: '5px 10px',
  borderRadius: 999,
  border: '1px solid rgba(43,76,143,0.18)',
  background: '#fff',
  color: '#3d4b66',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const small = { fontSize: 12, color: '#7c8aa6', lineHeight: 1.6 };
const imgBox = { marginTop: 8, borderRadius: 10, overflow: 'hidden', background: '#0f1c2e' };

return function Panel({ settings, draftSettings, setSettings, save, toast }) {
  const cfg = draftSettings || settings || {};
  const [form, setForm] = useState({
    enabled: cfg.enabled !== false,
    baseUrl: cfg.baseUrl || 'http://127.0.0.1:5178',
    roomDir: cfg.roomDir || '',
    groupPhoto: cfg.groupPhoto === true,
    openBrowser: cfg.openBrowser !== false,
  });
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const refresh = async () => {
    try {
      const r = await call('/state');
      if (r && r.ok === false) {
        setErr(r.message || '读不到');
        setState(null);
      } else {
        setErr('');
        setState(r);
      }
    } catch (e) {
      setErr(e.message || String(e));
      setState(null);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const doSave = () => run('save', async () => {
    if (typeof save === 'function') {
      await save(form);
      toast('保存好了');
    } else if (typeof setSettings === 'function') {
      setSettings(form);
      toast('已填入，点面板底部的保存');
    }
    await refresh();
  });

  const doOpen = () => run('open', async () => {
    const r = await call('/open', {});
    toast(r.message || '好');
    await refresh();
  });

  const doTest = () => run('test', async () => {
    const r = await call('/state');
    toast(r.ok === false ? r.message : r.summary || '连上了');
    setState(r.ok === false ? null : r);
  });

  const doPhoto = () => run('photo', async () => {
    const r = await call('/photo');
    if (r && r.dataUrl) {
      setPhoto(r.dataUrl);
      toast('拍好了');
    } else {
      toast((r && r.message) || '没拍到');
    }
  });

  const go = (spot) => run('go:' + spot, async () => {
    const r = await call('/goto', { spot });
    toast(r.message || '好');
    await refresh();
  });

  const loc = state && state.location;
  const spots = (state && state.spots) || [];
  const history = (state && state.history) || [];

  return h(
    'div',
    { className: 'ab-grid' },

    h(
      ui.Card,
      {
        title: '连接',
        desc: '大肥鱼的家是本地跑的 dfy-room 小游戏（默认 5178 端口）。先把家开起来，这里才能读到她的位置、拍第一视角。',
        right: h(ui.Switch, {
          on: form.enabled !== false,
          onChange: (v) => set('enabled', v),
        }),
      },
      h(ui.Row, { label: '家的地址' }, h('input', {
        className: 'ab-input',
        style: inputStyle,
        value: form.baseUrl,
        placeholder: 'http://127.0.0.1:5178',
        onChange: (e) => set('baseUrl', e.target.value),
      })),
      h(ui.Row, { label: '家的目录', hint: '填 dfy-room 文件夹的完整路径，才能一键启动（可选）' }, h('input', {
        className: 'ab-input',
        style: inputStyle,
        value: form.roomDir,
        placeholder: 'E:\\Cache\\qq-agent\\dfy-room',
        onChange: (e) => set('roomDir', e.target.value),
      })),
      h(ui.Row, { label: '群里也发照片', hint: '关着时只在私聊里发第一视角，群里只回文字位置' }, h(ui.Switch, {
        on: form.groupPhoto === true,
        onChange: (v) => set('groupPhoto', v),
      })),
      h(ui.Row, { label: '启动后打开浏览器', hint: '点「打开家」启动游戏时，顺便在浏览器里打开' }, h(ui.Switch, {
        on: form.openBrowser !== false,
        onChange: (v) => set('openBrowser', v),
      })),
      h('div', { style: box },
        h(ui.Btn, { onClick: doSave, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存设置'),
        h(ui.Btn, { onClick: doOpen, disabled: !!busy }, busy === 'open' ? '启动中…' : '打开家'),
        h(ui.Btn, { onClick: doTest, disabled: !!busy }, '测试连接'))
    ),

    h(
      ui.Card,
      {
        title: '她现在在哪',
        desc: err || undefined,
        right: h(ui.Btn, { onClick: refresh, disabled: !!busy }, '刷新'),
      },
      state
        ? h('div', null,
            h('div', { style: { fontSize: 16, fontWeight: 700, color: '#2b4c8f' } },
              `${(loc && loc.emoji) || '📍'} ${(loc && loc.name) || '还没报位置'}`),
            h('div', { style: small }, state.summary || ''),
            loc && loc.hint ? h('div', { style: small }, `📍 ${loc.hint}`) : null,
            h('div', { style: small },
              `${state.online ? '🟢 页面开着' : '⚪ 页面没开'} · 动作：${state.clip || '—'}${state.asleep ? ' · 睡着中' : ''}`,
              state.photo ? ` · 最近一张照片 ${Math.round((state.photo.ageMs || 0) / 1000)} 秒前` : ' · 还没有照片'))
          : h(ui.Empty, { icon: '🏠', text: err || '还没连上，先「打开家」' }),

      spots.length
        ? h('div', { style: { marginTop: 10 } },
            h('div', { style: small }, '送她去：'),
            h('div', { style: box },
              spots.map((s) => h('button', {
                key: s.id,
                style: chipStyle,
                onClick: () => go(s.id),
                title: s.desc || '',
              }, `${s.emoji || ''} ${s.name}`))))
        : null,

      h('div', { style: { ...box, marginTop: 10 } },
        h(ui.Btn, { onClick: doPhoto, disabled: !!busy }, busy === 'photo' ? '拍照中…' : '📸 拍一张第一视角')),
      photo ? h('div', { style: imgBox }, h('img', { src: photo, style: { width: '100%', display: 'block' } })) : null,
      photo ? h('div', { style: small },
        '这张也会同步到她家里，Aurabot 发这张图时用的是同一套拍摄。') : null
    ),

    history.length
      ? h(ui.Card, { title: '最近去过' },
          h('div', { style: small },
            history.map((h2, i) =>
              h('div', { key: i },
                `${(h2.emoji || '')} ${h2.name} · ${new Date(h2.at).toLocaleTimeString('zh-CN', { hour12: false })}`))))
      : null
  );
};
