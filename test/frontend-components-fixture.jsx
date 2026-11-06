import React, {useState, useEffect, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {CustomSelect} from '../web/src/custom-select.jsx';
import {Tooltip} from '../web/src/tooltip.jsx';
function Fixture(){
 const dialog=useRef(null);const [value,setValue]=useState('a'),[disabled,setDisabled]=useState(false),[empty,setEmpty]=useState(false),[showTip,setShowTip]=useState(true),[title,setTitle]=useState('fixture old tooltip');
 useEffect(()=>{dialog.current.showModal();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} aria-label="Component fixture" onCancel={e=>e.preventDefault()} style={{width:500,maxWidth:'calc(100vw - 32px)',padding:20}}>
 <form id="fixture-form"><label htmlFor="fixture-select">Fixture choice</label><CustomSelect id="fixture-select" name="choice" value={value} disabled={disabled} options={empty?[]:[{value:'a',label:'Alpha'},{value:'b',label:'Beta',disabled:true},{value:'c',label:'Charlie'},{value:'d',label:'Delta'}]} onChange={e=>setValue(e.target.value)}/><output id="fixture-value">{value}</output></form>
 <label id="implicit-fixture-label"><span>Implicit label</span><CustomSelect aria-label="Implicit fixture choice" value="a" options={[{value:"a",label:"Alpha"},{value:"b",label:"Beta"}]} onChange={()=>{}} /></label>
 <button type="button" onClick={()=>setDisabled(v=>!v)}>Disable select</button><button type="button" onClick={()=>setEmpty(v=>!v)}>Empty options</button>
 <button type="button" onClick={()=>setShowTip(false)}>Remove target</button><button type="button" onClick={()=>setTitle('fixture new tooltip')}>Update title</button>
 {showTip&&<button type="button" id="fixture-tip" title={title}><span id="fixture-child-a">Alpha</span><span id="fixture-child-b">Beta</span></button>}
 <Tooltip content="explicit component tooltip"><button type="button" id="fixture-explicit">Explicit tooltip</button></Tooltip>
 <div style={{height:120,overflow:'auto',marginTop:10}} id="fixture-scroller"><div style={{height:250}}><button type="button" id="scroll-tip" title="scroll tooltip">Scroll target</button></div></div>
 </dialog>;
}
export function mount(){const node=document.createElement('div');document.body.append(node);const root=createRoot(node);root.render(<Fixture/>);return()=>{root.unmount();node.remove();};}
