import React from 'react';
import type {ProjectData} from '../../types';
import {theme} from '../../config/theme';

export const RankingPanel: React.FC<{project: ProjectData; visibleIds: string[]; activeId?: string}> = ({project, visibleIds, activeId}) => (
  <section style={{position:'absolute', left:72, right:72, top:1370, height:420, padding:'28px 34px', boxSizing:'border-box', border:`1px solid ${theme.panelBorder}`, background:theme.panel, borderRadius:18, boxShadow:'0 18px 60px rgba(0,0,0,.25)'}}>
    <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18}}><span style={{fontSize:21, letterSpacing:6, color:theme.accent}}>RANKING</span><span style={{fontSize:17, color:theme.mutedText}}>LIVE REVEAL</span></div>
    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', columnGap:34, rowGap:10}}>
      {[...project.rankings].sort((a,b)=>a.rank-b.rank).map((item) => {
        const visible = visibleIds.includes(item.provinceId); const active = activeId === item.provinceId;
        return <div key={item.provinceId} style={{height:55, display:'grid', gridTemplateColumns:'56px 1fr auto', alignItems:'center', padding:'0 14px', opacity:visible?1:.23, borderLeft:`3px solid ${active?theme.accent:'transparent'}`, background:active?'rgba(41,229,210,.08)':'transparent', transition:'none'}}>
          <span style={{fontSize:20, fontWeight:800, color:theme.accent}}>{String(item.rank).padStart(2,'0')}</span><span style={{fontSize:21, fontWeight:650}}>{item.provinceTh || item.provinceEn}</span><span style={{fontSize:20, color:theme.mutedText}}>{item.valueLabel ?? item.value.toLocaleString()}</span>
        </div>;
      })}
    </div>
  </section>
);
