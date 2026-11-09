export const FILTER_KEYS=['channel-fba','channel-merchant','channel-yahoo','channel-mercari','channel-none','attention','parallel','container','home','watch','overstock','large','heavy','planning','draft'];
export function matchesOverviewFilters(row,keys=[],mode='all'){
 const selected=keys.filter(k=>FILTER_KEYS.includes(k));
 const match=k=>k==='channel-none'?Boolean(row.channels?.unlisted):k.startsWith('channel-')?row.channels?.[k.slice(8)]?.state==='active':k==='attention'?Boolean(row.attention?.length):Boolean(row.badges?.includes(k));
 return !selected.length||(mode==='any'?selected.some(match):selected.every(match));
}
