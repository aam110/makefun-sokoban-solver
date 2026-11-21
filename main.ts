import f from'node:fs'
for(let k=1;k<6;){let i='i00'+k++,t=f.readFileSync('/input/'+i+'/level.txt')+'',w=t.indexOf('\n')+1,s=t.replace(/\n/g,'#'),P=s.indexOf('@'),h=P/w|0,p=P%w,F=x=>s[x]!='#',o='',O=[-w,w,-1,1],C='udlr',g=x=>1n<<BigInt(x)
for(let j=h*w;j<h*w+w;j++)if(F(j))for(let e of[-w,w]){let c=j+e;if(!F(c))continue
let M={[j]:0,[c]:1},Q=[j,c],F2=y=>{for(let k of O){let z=y+k;if(F(z)&&!(z in M)){M[z]=Q.push(z)-1;F2(z)}}};F2(c)
let G=0n,B=0n,E=0n,N=Q.map((x,z)=>{let a=O.map(k=>M[x+k]??-1),v=s[x];if(v=='.'||v=='*')G|=g(z);else if((a[0]|a[1])<0&&(a[2]|a[3])<0)E|=g(z);if(v=='$'||v=='*')B|=g(z);return a})
while(p<c%w)o+='r',p++;while(p>c%w)o+='l',p--
let a=[[B,0,'']],b=[],S={}
for(let T;(T=a.pop()||(a=b.reverse(),b=[],a.pop()));){let[m,u,mv]=T,k=m+','+u;if(S[k])continue;S[k]=1;if(m==G&&!u){o+=mv;break}
N[u].forEach((y,kk)=>{if(y<0)return;let z=mv+C[kk];if(m&g(y)){let ah=N[y][kk];if(ah<0||m&g(ah))return;let m2=m^g(y)^g(ah);if(m2&E)return;b.push([m2,y,z])}else a.push([m,y,z])})}
}f.mkdirSync(P='/output/'+i);f.writeFileSync(P+'/solution.txt',o)}
