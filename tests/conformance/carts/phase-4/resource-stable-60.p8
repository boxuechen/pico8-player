pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 values={}
 for i=1,256 do
  values[i]={i,i+1,i+2,i+3}
 end
 poke(0x5210,#values)
 poke(0x5211,0)
end

function _update60()
 poke(0x5211,(peek(0x5211)+1)%128)
 if btn(0) then poke(0x5212,peek(0x5212)+1) end
end

function _draw()
 cls(1)
 pset(peek(0x5211),0,7)
 pset(peek(0x5212),1,7)
end
