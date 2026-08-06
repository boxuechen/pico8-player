pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 local retained={}
 for i=1,10000 do
  retained[i]="012345678901234567890123456789"
 end
 poke(0x5230,1)
end

function _update() end
function _draw() cls(8) end
