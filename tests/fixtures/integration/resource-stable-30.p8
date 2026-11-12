pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 values={}
 for i=1,256 do
  values[i]={i,i+1,i+2,i+3}
 end
 poke(0x5200,#values)
 poke(0x5201,0)
end

function _update()
 poke(0x5201,(peek(0x5201)+1)%128)
 if btn(0) then poke(0x5202,peek(0x5202)+1) end
end

function _draw()
 cls(1)
 pset(peek(0x5201),0,7)
 pset(peek(0x5202),1,7)
end
