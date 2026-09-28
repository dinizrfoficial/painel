/*
 * Z-Link Talk - AMR-WB browser player
 *
 * Recebe pacotes binários Z-Link v1 com frames AMR-WB e faz:
 *   AMR-WB -> @audio/decode-amr (OpenCORE/WASM) -> Float32 PCM -> Web Audio
 *
 * O módulo real do decoder é servido pelo próprio servidor Render em:
 *   /panel-codec/decode-amr.js
 *
 * O PCM é reproduzido por AudioWorklet com jitter buffer. Caso AudioWorklet
 * não esteja disponível, existe fallback com AudioBufferSourceNode.
 */
(function(global){
'use strict';

var AMR_WB_HEADER=new Uint8Array([0x23,0x21,0x41,0x4D,0x52,0x2D,0x57,0x42,0x0A]);
var ZLINK_HEADER_SIZE=6;
var ZLINK_MAGIC_0=0x5A;
var ZLINK_MAGIC_1=0x4C;
var ZLINK_VERSION=0x01;
var ZLINK_CODEC_AMR_WB=0x01;

function normalizeServer(v){
  return String(v||'').trim().replace(/\/+$/,'');
}

function copyU8(data){
  var src=data instanceof Uint8Array?data:new Uint8Array(data);
  return src.slice();
}

function resampleLinear(input,inputRate,outputRate){
  if(!input||!input.length)return new Float32Array(0);
  inputRate=Number(inputRate)||16000;
  outputRate=Number(outputRate)||inputRate;
  if(inputRate===outputRate)return input instanceof Float32Array?input:new Float32Array(input);

  var outLen=Math.max(1,Math.round(input.length*outputRate/inputRate));
  var out=new Float32Array(outLen);
  var ratio=inputRate/outputRate;

  for(var i=0;i<outLen;i++){
    var pos=i*ratio;
    var a=Math.floor(pos);
    var b=Math.min(a+1,input.length-1);
    var frac=pos-a;
    out[i]=input[a]+(input[b]-input[a])*frac;
  }
  return out;
}

class ZLinkAmrWbPlayer{
  constructor(options){
    options=options||{};
    this.workletUrl=options.workletUrl||'./zlink-pcm-worklet.js';
    this.prebufferMs=Math.max(40,Math.min(220,Number(options.prebufferMs)||80));
    this.ctx=null;
    this.gain=null;
    this.worklet=null;
    this.decoderFactory=null;
    this.decoderModuleUrl='';
    this.decoder=null;
    this.decoderReady=false;
    this.decoderGeneration=0;
    this.pendingPackets=[];
    this.maxPendingPackets=50;
    this.fallbackNextTime=0;
    this.lastSequence=null;
    this.sequenceGaps=0;
    this.decodedFrames=0;
    this.droppedPending=0;
  }

  async ensure(serverBase,volume){
    serverBase=normalizeServer(serverBase);
    if(!serverBase)throw new Error('Servidor inválido para carregar o decoder AMR-WB.');

    if(!global.AudioContext&&!global.webkitAudioContext){
      throw new Error('Este navegador não possui Web Audio compatível.');
    }

    if(!this.ctx){
      var AudioCtx=global.AudioContext||global.webkitAudioContext;
      try{
        this.ctx=new AudioCtx({latencyHint:'interactive',sampleRate:16000});
      }catch(_){
        this.ctx=new AudioCtx({latencyHint:'interactive'});
      }

      this.gain=this.ctx.createGain();
      this.gain.gain.value=Number.isFinite(Number(volume))?Number(volume):0.9;
      this.gain.connect(this.ctx.destination);

      if(this.ctx.audioWorklet&&global.AudioWorkletNode){
        try{
          var absoluteWorkletUrl=new URL(this.workletUrl,document.baseURI).href;
          await this.ctx.audioWorklet.addModule(absoluteWorkletUrl);
          this.worklet=new AudioWorkletNode(this.ctx,'zlink-pcm-player',{
            numberOfInputs:0,
            numberOfOutputs:1,
            outputChannelCount:[1],
            processorOptions:{prebufferMs:this.prebufferMs}
          });
          this.worklet.connect(this.gain);
        }catch(err){
          console.warn('[Z-Link AMR-WB] AudioWorklet indisponível; usando fallback.',err);
          this.worklet=null;
        }
      }
    }

    if(this.ctx.state==='suspended'){
      await this.ctx.resume();
    }

    var moduleUrl=serverBase+'/panel-codec/decode-amr.js';
    if(!this.decoderFactory||this.decoderModuleUrl!==moduleUrl){
      var mod;
      try{
        mod=await import(moduleUrl);
      }catch(err){
        throw new Error('Não foi possível carregar o decoder AMR-WB do servidor: '+(err&&err.message?err.message:err));
      }
      if(!mod||typeof mod.decoder!=='function'){
        throw new Error('O módulo AMR-WB carregado não possui a função decoder().');
      }
      this.decoderFactory=mod.decoder;
      this.decoderModuleUrl=moduleUrl;
    }

    return true;
  }

  async beginTransmission(){
    var generation=++this.decoderGeneration;
    this.decoderReady=false;
    this.pendingPackets=[];
    this.lastSequence=null;
    this.sequenceGaps=0;
    this.decodedFrames=0;

    if(this.worklet){
      this.worklet.port.postMessage({type:'reset',prebufferMs:this.prebufferMs});
    }else if(this.ctx){
      this.fallbackNextTime=this.ctx.currentTime+this.prebufferMs/1000;
    }

    if(this.decoder){
      try{this.decoder.free();}catch(_){}
      this.decoder=null;
    }

    if(!this.decoderFactory){
      return;
    }

    try{
      var dec=await this.decoderFactory();
      if(generation!==this.decoderGeneration){
        try{dec.free();}catch(_){}
        return;
      }

      /*
       * O decoder streaming detecta AMR-WB pelo magic "#!AMR-WB\n".
       * Enviamos uma única vez no início de cada transmissão. Os frames
       * seguintes são entregues diretamente, já com o byte TOC.
       */
      dec.decode(AMR_WB_HEADER);

      this.decoder=dec;
      this.decoderReady=true;

      if(this.pendingPackets.length){
        var queued=this.pendingPackets;
        this.pendingPackets=[];
        for(var i=0;i<queued.length;i++){
          this._decodePacket(queued[i]);
        }
      }
    }catch(err){
      this.decoderReady=false;
      this.decoder=null;
      throw err;
    }
  }

  endTransmission(){
    /*
     * Não limpamos imediatamente o jitter buffer: os últimos frames já
     * decodificados devem terminar de tocar. O próximo beginTransmission()
     * zera o buffer antes de começar outro falante.
     */
    this.lastSequence=null;
  }

  resetPlayback(){
    ++this.decoderGeneration;
    this.decoderReady=false;
    this.pendingPackets=[];
    this.lastSequence=null;

    if(this.decoder){
      try{this.decoder.free();}catch(_){}
      this.decoder=null;
    }

    if(this.worklet){
      this.worklet.port.postMessage({type:'reset',prebufferMs:this.prebufferMs});
    }

    if(this.ctx){
      this.fallbackNextTime=this.ctx.currentTime;
    }
  }

  feedPacket(buffer){
    if(!buffer)return false;
    var u8=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);

    if(
      u8.length<=ZLINK_HEADER_SIZE||
      u8[0]!==ZLINK_MAGIC_0||
      u8[1]!==ZLINK_MAGIC_1||
      u8[2]!==ZLINK_VERSION||
      u8[3]!==ZLINK_CODEC_AMR_WB
    ){
      return false;
    }

    if(!this.decoderReady||!this.decoder){
      if(this.pendingPackets.length>=this.maxPendingPackets){
        this.pendingPackets.shift();
        this.droppedPending++;
      }
      this.pendingPackets.push(copyU8(u8));
      return true;
    }

    this._decodePacket(u8);
    return true;
  }

  _decodePacket(u8){
    if(!this.decoder)return;

    var seq=((u8[4]<<8)|u8[5])&0xFFFF;
    if(this.lastSequence!==null){
      var expected=(this.lastSequence+1)&0xFFFF;
      if(seq!==expected){
        var delta=(seq-expected+65536)&0xFFFF;
        if(delta<32768)this.sequenceGaps+=delta+1;
      }
    }
    this.lastSequence=seq;

    var frame=u8.subarray(ZLINK_HEADER_SIZE);
    var result;
    try{
      result=this.decoder.decode(frame);
    }catch(err){
      console.warn('[Z-Link AMR-WB] frame não decodificado:',err);
      return;
    }

    if(!result||!result.channelData||!result.channelData.length)return;
    var pcm=result.channelData[0];
    if(!pcm||!pcm.length)return;

    this.decodedFrames++;
    this._playPcm(pcm,Number(result.sampleRate)||16000);
  }

  _playPcm(pcm,sampleRate){
    if(!this.ctx||!pcm||!pcm.length)return;

    if(this.worklet){
      var samples=resampleLinear(pcm,sampleRate,this.ctx.sampleRate);
      this.worklet.port.postMessage({type:'pcm',samples:samples},[samples.buffer]);
      return;
    }

    var audioBuffer=this.ctx.createBuffer(1,pcm.length,sampleRate);
    audioBuffer.copyToChannel(pcm,0);
    var src=this.ctx.createBufferSource();
    src.buffer=audioBuffer;
    src.connect(this.gain);

    var now=this.ctx.currentTime;
    if(this.fallbackNextTime<now||this.fallbackNextTime>now+0.8){
      this.fallbackNextTime=now+this.prebufferMs/1000;
    }

    src.start(this.fallbackNextTime);
    this.fallbackNextTime+=audioBuffer.duration;
  }

  setVolume(v){
    var value=Math.max(0,Math.min(1,parseFloat(v)));
    if(this.gain&&Number.isFinite(value)){
      this.gain.gain.value=value;
    }
  }

  async resume(){
    if(this.ctx&&this.ctx.state==='suspended'){
      await this.ctx.resume();
    }
  }

  close(){
    this.resetPlayback();
    if(this.worklet){
      try{this.worklet.disconnect();}catch(_){}
      this.worklet=null;
    }
    if(this.gain){
      try{this.gain.disconnect();}catch(_){}
      this.gain=null;
    }
    if(this.ctx){
      try{this.ctx.close();}catch(_){}
      this.ctx=null;
    }
  }

  stats(){
    return {
      decodedFrames:this.decodedFrames,
      sequenceGaps:this.sequenceGaps,
      pendingDrops:this.droppedPending,
      worklet:!!this.worklet,
      sampleRate:this.ctx?this.ctx.sampleRate:0
    };
  }
}

global.ZLinkAmrWbPlayer=ZLinkAmrWbPlayer;
})(window);
