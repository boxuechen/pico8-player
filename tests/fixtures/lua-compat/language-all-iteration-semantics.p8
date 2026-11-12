pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local text=""
 for value in all("abc") do text..=value end
 local values={1,2,3}
 local sum=0
 for value in all(values) do
  sum+=value
  if value==2 then del(values,value) end
 end
 for value in all(nil) do sum=99 end
 poke(0x5000,text=="abc" and 1 or 0,sum)
end
function _update() end
function _draw() end
