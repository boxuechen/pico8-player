pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function seed_audio()
 poke(0x3100,0x80,0xc0,0x40,0x40)
 for i=0,31 do
  poke(0x3200+i*2,24+i%12,14)
 end
 poke(0x3241,8)
 poke(0x3242,0)
 poke(0x3243,16)
end

function snapshot_reset_defaults()
 poke(0x5020,peek(0x5f00),peek(0x5f01),peek(0x5f10),peek(0x5f20))
 poke(0x5024,peek(0x5f22),peek(0x5f25),peek(0x5f28),peek(0x5f29))
 poke(0x5028,peek(0x5f2a),peek(0x5f2b),peek(0x5f31),peek(0x5f32))
end

function _init()
 seed_audio()
 cartdata("phase4e")
 local runs=dget(0)+1
 dset(0,runs)
 local param=stat(6)
 poke(0x5000,#param)
 poke(0x5001,ord(param,1) or 0)
 poke(0x5002,runs)
 poke(0x5003,stat(99)==false and 1 or 0)
 poke(0x5008,peek(0x100))
 poke4(0x5010,time())
 stage=param=="" and 0 or 1
 frames=0
end

function _update()
 frames+=1
 poke(0x5004,frames)
 if btn(4) then poke(0x5005,peek(0x5005)+1) end
 if btnp(4) then poke(0x5006,peek(0x5006)+1) end
 poke4(0x5014,time())
 if stage==0 then
  if frames==1 then
   sfx(0,0,0,8)
   poke(0x100,0x5a)
   cstore(0x100,0x100,1)
   poke(0x100,0)
   reload(0x100,0x100,1)
   poke(0x5007,peek(0x100))
   camera(7,9)
   clip(1,2,3,4)
   pal(1,8)
   fillp(0x1234)
   reset()
   snapshot_reset_defaults()
   assert(peek(0x100)==0x5a,"current-cart overlay drifted")
  elseif frames>=2 and peek(0x5006)>0 then
   run("again")
  end
 else
  if frames==1 then
   music(0,nil,1)
   sfx(0,1,0,8)
  elseif frames>=3 and peek(0x5006)>0 then
   dset(1,0x4e.0000)
   stop("done")
  end
 end
end

function _draw()
 cls(stage==0 and 1 or 2)
 for i=0,11 do
  pset(i,peek(0x5000+i)%128,7+i%8)
 end
end
