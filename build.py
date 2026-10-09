import os, re
src = 'src'
r = lambda f: open(os.path.join(src, f), encoding='utf-8').read()
css = r('styles.css'); body = r('body.html')
worker = r('fft.js') + '\n' + r('master.js') + '\n' + r('worker.js')
app = '\n'.join(r(f) for f in ['fft.js','util.js','plugins.js','engine.js','tempo.js','shell.js','explorer.js','beatmap.js','ai.js','chainer.js','looplab.js','arrange.js','editor.js','stems.js','mixer.js','main.js'])
for name, code in [('worker', worker), ('app', app)]:
    assert '</script' not in code.lower(), name
app = '"use strict";\n' + app
head_meta = '<meta name="description" content="Rush Music Studio: offline, open-source multitrack studio, audio editor and real-time stem separator.">'
aiw = r('aiworker.js')
assert '</script' not in aiw.lower()
aitag = f'<script id="rush-ai-src" type="text/plain">\n{aiw}\n</script>\n'
mp3 = r('vendor/lame.min.js') + '\n' + r('mp3worker.js')
assert '</script' not in mp3.lower()
mp3tag = f'<script id="rush-mp3-src" type="text/plain">\n/* LAME MP3 encoder (lamejs, LGPL-3.0, unmodified): https://github.com/zhuker/lamejs  ·  lame.sourceforge.net */\n{mp3}\n</script>\n'
inner = f'<title>Rush Music Studio</title>\n<style>\n{css}\n</style>\n{body}\n<script id="rush-dsp-src" type="text/plain">\n{worker}\n</script>\n{mp3tag}{aitag}<script>\n{app}\n</script>\n'
os.makedirs('dist', exist_ok=True)
standalone = f'<!doctype html>\n<html lang="en" data-theme="dark">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n{head_meta}\n<title>Rush Music Studio</title>\n<style>\n{css}\n</style>\n</head>\n<body>\n{body}\n<script id="rush-dsp-src" type="text/plain">\n{worker}\n</script>\n{mp3tag}{aitag}<script>\n{app}\n</script>\n</body>\n</html>\n'
open('dist/RushMusicStudio.html','w',encoding='utf-8').write(standalone)
open('dist/rush-music-studio.html','w',encoding='utf-8').write(inner)
print('built', len(standalone)//1024, 'KB')
