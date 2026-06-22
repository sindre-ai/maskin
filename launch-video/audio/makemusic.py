import numpy as np, soundfile as sf
sr=44100; dur=51.0; n=int(sr*dur); audio=np.zeros(n)
# upbeat: 120 BPM, four-on-the-floor kick, offbeat hats, 16th arpeggio, C-G-Am-F
chords=[[261.63,329.63,392.00],[196.00,246.94,293.66],[220.00,261.63,329.63],[174.61,220.00,261.63]]
bassN=[65.41,49.00,55.00,43.65]
beat=0.5; bar=2.0
rng=np.random.default_rng(7)
def tone(freq,start,length,amp,kind):
    s=int(start*sr); e=min(n,int((start+length)*sr))
    if s>=n or e<=s: return
    tt=np.arange(e-s)/sr
    w=np.sin(2*np.pi*freq*tt)+0.25*np.sin(2*np.pi*2*freq*tt)+0.12*np.sin(2*np.pi*3*freq*tt)
    if kind=='pad': env=np.clip(np.minimum(tt/0.25,(length-tt)/0.4),0,1)
    else: env=np.exp(-tt*7)*(1-np.exp(-tt*120))   # snappy pluck
    audio[s:e]+=amp*w*env
def kick(start,amp=0.6):
    s=int(start*sr); L=int(0.16*sr); e=min(n,s+L)
    if s>=n: return
    tt=np.arange(e-s)/sr
    f=110*np.exp(-tt*32)+48
    audio[s:e]+=amp*np.sin(2*np.pi*np.cumsum(f)/sr)*np.exp(-tt*14)
def hat(start,amp=0.09):
    s=int(start*sr); L=int(0.04*sr); e=min(n,s+L)
    if s>=n: return
    tt=np.arange(e-s)/sr
    nz=rng.standard_normal(e-s)
    audio[s:e]+=amp*nz*np.exp(-tt*120)
ti=0.0; i=0
while ti<dur:
    c=chords[i%4]
    for f in c: tone(f,ti,bar+0.1,0.045,'pad')          # soft pad
    # bass on beats 1 & 3
    tone(bassN[i%4],ti,0.45,0.13,'pluck'); tone(bassN[i%4],ti+2*beat,0.45,0.12,'pluck')
    # four-on-the-floor kick + offbeat hats
    for b in range(4):
        kick(ti+b*beat)
        hat(ti+b*beat+0.25)
    # 16th-note bright arpeggio
    arp=[c[0]*2,c[1]*2,c[2]*2,c[1]*2, c[0]*2,c[2]*2,c[1]*2,c[2]*2,
         c[0]*4,c[1]*2,c[2]*2,c[1]*2, c[0]*2,c[1]*2,c[2]*2,c[0]*4]
    st=bar/16
    for k in range(16): tone(arp[k],ti+k*st,st*1.5,0.05,'pluck')
    ti+=bar; i+=1
# light reverb on the whole thing
d=int(0.07*sr); rv=audio.copy()
for k in range(1,4):
    if d*k<n: rv[d*k:]+=audio[:n-d*k]*(0.22**k)
audio=rv
# gentle high cut for warmth
ker=np.hanning(8); ker/=ker.sum(); audio=np.convolve(audio,ker,mode='same')
audio/=max(1e-9,np.max(np.abs(audio))); audio*=0.85
fi=int(1.2*sr); audio[:fi]*=np.linspace(0,1,fi)
fo=int(3.0*sr); audio[-fo:]*=np.linspace(1,0,fo)
sh=int(0.008*sr); R=np.zeros(n); R[sh:]=audio[:n-sh]
sf.write('audio/music.wav',np.stack([audio,R*0.96],axis=1),sr)
print("ok")
