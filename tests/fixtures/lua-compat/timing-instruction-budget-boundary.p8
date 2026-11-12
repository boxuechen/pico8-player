pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
local initialized=false
function _init()
 local marker=0
 for y=1,900 do
  for x=1,900 do marker=(marker+1)%127 end
 end
 initialized=true
 poke(0x5000,1)
end
function _update() end
function _draw()
 local marker=0
 for y=1,1800 do
  for x=1,1800 do marker=(marker+1)%127 end
 end
 local count=0
 for address=0x6000,0x7fff,4 do count+=1 end
 poke4(0x5004,count)
 poke(0x5008,initialized and marker>=0 and 1 or 0)
end
