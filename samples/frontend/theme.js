try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}catch(e){}
// English interface: left-to-right, and numbers/dates in English digits (the code asks for 'ar-SY').
try{if(localStorage.getItem('lang')==='en'){var r=document.documentElement;r.lang='en';r.dir='ltr';
var fx=function(l){return typeof l==='string'&&/^ar/i.test(l)?'en-GB':Array.isArray(l)?l.map(fx):l;};
var wrap=function(p,k){var f=p[k];p[k]=function(l,o){return f.call(this,fx(l),o);};};
wrap(Number.prototype,'toLocaleString');wrap(Date.prototype,'toLocaleString');wrap(Date.prototype,'toLocaleDateString');wrap(Date.prototype,'toLocaleTimeString');
var NF=Intl.NumberFormat,DF=Intl.DateTimeFormat;Intl.NumberFormat=function(l,o){return new NF(fx(l),o);};Intl.NumberFormat.prototype=NF.prototype;
Intl.DateTimeFormat=function(l,o){return new DF(fx(l),o);};Intl.DateTimeFormat.prototype=DF.prototype;Intl.DateTimeFormat.supportedLocalesOf=DF.supportedLocalesOf;}}catch(e){}
