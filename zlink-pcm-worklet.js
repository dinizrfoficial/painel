/*
 * Z-Link Talk - PCM jitter buffer para AudioWorklet.
 *
 * Recebe PCM Float32 já convertido para a sampleRate do AudioContext.
 * Mantém uma pequena reserva antes de iniciar e rebufferiza em underrun.
 */
class ZLinkPcmProcessor extends AudioWorkletProcessor{
  constructor(options){
    super();
    var p=(options&&options.processorOptions)||{};
    this.prebufferMs=Math.max(40,Math.min(220,Number(p.prebufferMs)||80));
    this.capacity=Math.max(8192,Math.ceil(sampleRate*3));
    this.buffer=new Float32Array(this.capacity);
    this.readPos=0;
    this.writePos=0;
    this.available=0;
    this.started=false;
    this.prebufferSamples=Math.max(128,Math.round(sampleRate*this.prebufferMs/1000));

    this.port.onmessage=(event)=>{
      var data=event.data||{};
      if(data.type==='reset'){
        if(Number.isFinite(Number(data.prebufferMs))){
          this.prebufferMs=Math.max(40,Math.min(220,Number(data.prebufferMs)));
          this.prebufferSamples=Math.max(128,Math.round(sampleRate*this.prebufferMs/1000));
        }
        this.readPos=0;
        this.writePos=0;
        this.available=0;
        this.started=false;
        return;
      }

      if(data.type==='pcm'&&data.samples){
        var samples=data.samples instanceof Float32Array?data.samples:new Float32Array(data.samples);
        this.write(samples);
      }
    };
  }

  write(samples){
    if(!samples||!samples.length)return;

    var start=0;
    if(samples.length>this.capacity){
      start=samples.length-this.capacity;
    }

    for(var i=start;i<samples.length;i++){
      if(this.available>=this.capacity){
        this.readPos=(this.readPos+1)%this.capacity;
        this.available--;
      }

      this.buffer[this.writePos]=samples[i];
      this.writePos=(this.writePos+1)%this.capacity;
      this.available++;
    }
  }

  process(inputs,outputs){
    var out=outputs[0]&&outputs[0][0];
    if(!out)return true;

    out.fill(0);

    if(!this.started){
      if(this.available>=this.prebufferSamples){
        this.started=true;
      }else{
        return true;
      }
    }

    for(var i=0;i<out.length;i++){
      if(this.available<=0){
        this.started=false;
        break;
      }

      out[i]=this.buffer[this.readPos];
      this.readPos=(this.readPos+1)%this.capacity;
      this.available--;
    }

    return true;
  }
}

registerProcessor('zlink-pcm-player',ZLinkPcmProcessor);
