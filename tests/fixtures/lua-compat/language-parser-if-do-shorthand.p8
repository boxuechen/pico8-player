pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local value=0
 if value==0 do
  value=7
 end
 if value==7 do value+=1 end
 poke(0x5000,value)
end
function _update() end
function _draw() end
