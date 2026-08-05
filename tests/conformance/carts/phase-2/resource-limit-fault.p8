pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 local s="x"
 for i=1,16 do s=s..s end
 print(s.."x")
end

function _update60() end
function _draw() end
