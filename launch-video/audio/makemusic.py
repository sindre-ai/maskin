import numpy as np, soundfile as sf
sr=44100; dur=51.0; n=int(sr*dur)
audio=np.zeros(n)
# I-V-vi-IV in C (calm, optimistic), 2s per chord, looped
chords=[[261.63,329.63,392.00],   # C  (C E G)
        [196.00,246.94,293.66],   # G  (G B D)
        [220.00,261.63,329.63],   # Am (A C E)
        [174.61,220.00,261.63]]   # F  (F A C)
bassN=[65.41,49.00,55.00,43.65]   # C2 G1 A1 F1
clen=2.0
def add(freq,start,length,amp,kind):
    s=int(start*sr); e=min(n,int((start+length)*sr))
    if s>=n or e<=s: return
    tt=np.arange(e-s)/sr
    w=np.sin(2*np.pi*freq*tt)+0.28*np.sin(2*np.pi*2*freq*tt)+0.12*np.sin(2*np.pi*3*freq*tt)
    if kind=='pad':
        env=np.clip(np.minimum(tt/0.35,(length-tt)/0.5),0,1)
    else:  # pluck (soft, decaying)
        env=np.exp(-tt*3.2)*(1-np.exp(-tt*80))
    audio[s:e]+=amp*w*env
ti=0.0; i=0
while ti<dur:
    c=chords[i%4]
    for f in c: add(f,ti,clen+0.15,0.085,'pad')         # sustained pad
    add(bassN[i%4],ti,clen+0.1,0.14,'pad')              # bass
    arp=c+[c[0]*2,c[1]*2]                                # arpeggio incl octave
    step=clen/6
    for k in range(6): add(arp[k%len(arp)],ti+k*step,step*1.6,0.075,'pluck')
    ti+=clen; i+=1
# gentle feedback reverb
d=int(0.11*sr); rv=audio.copy()
for k in range(1,5):
    if d*k<n: rv[d*k:]+=audio[:n-d*k]*(0.3**k)
audio=rv
# soft low-pass (FIR Hann smoothing) for warmth
k=np.hanning(16); k/=k.sum()
audio=np.convolve(audio,k,mode='same')
# normalize, fades
audio/=max(1e-9,np.max(np.abs(audio))); audio*=0.7
fi=int(2.5*sr); audio[:fi]*=np.linspace(0,1,fi)
fo=int(4.0*sr); audio[-fo:]*=np.linspace(1,0,fo)
# stereo with a small Haas delay for width
sh=int(0.009*sr); R=np.zeros(n); R[sh:]=audio[:n-sh]
st=np.stack([audio,R*0.95],axis=1)
sf.write('audio/music.wav',st,sr)
print('wrote', st.shape, 'peak', np.max(np.abs(st)))
