import React, { useState, useEffect } from 'react';

function short(addr){
  if(!addr) return '';
  return addr.slice(0,6) + '…' + addr.slice(-4);
}

export default function ConnectButton(){
  const [addr, setAddr] = useState(null);

  useEffect(()=>{
    const a = localStorage.getItem('fluxio-address');
    if(a) setAddr(a);
  },[]);

  function connect(){
    // Mock connect flow for demo
    const mock = 'F4X1Oqwerty12345DemoAddress67890';
    localStorage.setItem('fluxio-address', mock);
    setAddr(mock);
  }

  function disconnect(){
    localStorage.removeItem('fluxio-address');
    setAddr(null);
  }

  return (
    <div>
      {addr ? (
        <button className="btn btn-primary" onClick={disconnect} title={addr}>{short(addr)}</button>
      ) : (
        <button className="btn" onClick={connect}>Connect Wallet</button>
      )}
    </div>
  );
}
